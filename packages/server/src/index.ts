import { WebSocketServer, WebSocket } from "ws";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { createSession, runAgent, type AgentSession } from "./agent.js";
import { createTools } from "./tools.js";
import { setupGitCredentials } from "./gitCredentials.js";
import { verifyToken, registerAnonymous, type AuthPayload } from "./auth.js";
import { isDockerEnabled, getContainer } from "./docker.js";
import { initDb, listUserSessions, deleteSession } from "./db.js";
import { checkQuota, incrementUsage, getUserQuota } from "./resourceLimits.js";
import { handleOAuthRoute } from "./oauth.js";
import { handleFileUpload, handleFileDownload } from "./fileTransfer.js";
import { isPoolEnabled, initPool } from "./containerPool.js";

const PORT = parseInt(process.env.PORT || "3100", 10);

const sessions = new Map<string, AgentSession>();

// Initialise DB before starting WebSocket server
await initDb();

// Initialize container pool if enabled
if (isPoolEnabled()) {
  await initPool();
}

// ── HTTP Server (for OAuth, file transfer, etc.) ──────────

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "", `http://localhost:${PORT}`);

  // Health check
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", timestamp: Date.now() }));
    return;
  }

  // OAuth endpoints
  if (url.pathname.startsWith("/oauth/")) {
    const handled = await handleOAuthRoute(req, res, url);
    if (handled) return;
  }

  // File transfer endpoints
  if (url.pathname === "/api/files/upload" && req.method === "POST") {
    await handleFileUpload(req, res);
    return;
  }
  if (url.pathname === "/api/files/download" && req.method === "GET") {
    await handleFileDownload(req, res, url);
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not Found" }));
});

const wss = new WebSocketServer({ server: httpServer });
httpServer.listen(PORT, () => {
  console.log(`Pocket Code server listening on ws://localhost:${PORT} (HTTP+WS)`);
});

wss.on("connection", (ws: WebSocket) => {
  let session: AgentSession | null = null;
  let currentAbort: AbortController | null = null;
  let auth: AuthPayload | null = null;
  console.log("[WS] Client connected");

  ws.on("message", async (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());
      console.log("[WS] Received:", msg.type);

      switch (msg.type) {
        // ── Anonymous registration ─────────────────────
        case "register": {
          const deviceId = msg.deviceId;
          if (!deviceId) {
            send(ws, { type: "error", error: "deviceId is required" });
            return;
          }
          const result = registerAnonymous(deviceId);
          send(ws, {
            type: "auth",
            token: result.token,
            userId: result.userId,
          });
          break;
        }

        // ── Session init (requires auth) ───────────────
        case "init": {
          // Verify token
          if (msg.token) {
            auth = verifyToken(msg.token);
          }
          if (!auth) {
            send(ws, { type: "error", error: "Invalid or missing token. Send register first." });
            return;
          }

          const sessionId = msg.sessionId || crypto.randomUUID();
          if (sessions.has(sessionId)) {
            session = sessions.get(sessionId)!;
            // Verify session belongs to this user
            if (session.userId !== auth.userId) {
              send(ws, { type: "error", error: "Session does not belong to this user." });
              session = null;
              return;
            }
          } else {
            session = await createSession(sessionId, auth.userId);
            sessions.set(sessionId, session);
          }
          // Docker isolation: get or create container
          if (isDockerEnabled() && !session.containerId) {
            try {
              session.containerId = await getContainer(auth.userId, session.workspace);
              console.log(`[WS] Docker container: ${session.containerId.slice(0, 12)}`);
            } catch (err: any) {
              console.error("[WS] Failed to create Docker container:", err.message);
              // Continue without Docker — falls back to host execution
            }
          }
          if (msg.model) {
            session.modelKey = msg.model;
          }
          if (msg.customPrompt !== undefined) {
            session.customPrompt = msg.customPrompt || undefined;
          }
          // Setup git credentials if provided
          if (msg.gitCredentials?.length > 0) {
            try {
              await setupGitCredentials(session.workspace, msg.gitCredentials);
            } catch (err: any) {
              console.error("[WS] Failed to setup git credentials:", err.message);
            }
          }
          send(ws, {
            type: "session",
            sessionId: session.sessionId,
            workspace: session.workspace,
          });
          break;
        }

        case "message": {
          if (!session) {
            send(ws, { type: "error", error: "No session. Send init first." });
            return;
          }
          // Check API call quota
          if (auth) {
            const quotaCheck = checkQuota(auth.userId, "api_call");
            if (!quotaCheck.allowed) {
              send(ws, { type: "error", error: quotaCheck.reason });
              send(ws, { type: "done" });
              return;
            }
            incrementUsage(auth.userId, "api_call");
          }
          if (msg.model) {
            session.modelKey = msg.model;
          }
          if (msg.customPrompt !== undefined) {
            session.customPrompt = msg.customPrompt || undefined;
          }

          // Conversation branching: rewind messages if requested
          if (typeof msg.rewindTo === "number" && msg.rewindTo >= 0) {
            session.messages = session.messages.slice(0, msg.rewindTo);
          }

          const abort = new AbortController();
          currentAbort = abort;
          await runAgent(session, msg.content, (event) => {
            send(ws, event);
          }, abort.signal, msg.images);
          currentAbort = null;
          break;
        }

        case "get-quota": {
          if (!auth) {
            send(ws, { type: "error", error: "Not authenticated." });
            return;
          }
          const quota = getUserQuota(auth.userId);
          send(ws, { type: "quota", ...quota });
          break;
        }

        // ── Geek mode: execute a single tool on demand ──
        case "tool-exec": {
          if (!session) {
            send(ws, { type: "error", error: "No session. Send init first." });
            return;
          }
          const { toolName, args, callId } = msg;
          const tools = createTools(session.workspace, session.containerId);
          const toolFn = (tools as Record<string, any>)[toolName];
          if (!toolFn) {
            send(ws, {
              type: "tool-result",
              callId,
              toolName,
              result: { success: false, error: `Unknown tool: ${toolName}` },
            });
            break;
          }
          try {
            const result = await toolFn.execute(args);
            send(ws, { type: "tool-result", callId, toolName, result });
          } catch (err: any) {
            send(ws, {
              type: "tool-result",
              callId,
              toolName,
              result: { success: false, error: err.message },
            });
          }
          break;
        }

        // ── File operations (both modes) ──
        case "list-files": {
          if (!session) {
            send(ws, { type: "error", error: "No session. Send init first." });
            return;
          }
          const listTools = createTools(session.workspace, session.containerId) as Record<string, any>;
          try {
            const result = await listTools.listFiles.execute({ path: msg.path || "." });
            send(ws, { type: "file-list", path: msg.path || ".", _reqId: msg._reqId, ...result });
          } catch (err: any) {
            send(ws, { type: "file-list", path: msg.path || ".", _reqId: msg._reqId, success: false, error: err.message });
          }
          break;
        }

        case "read-file": {
          if (!session) {
            send(ws, { type: "error", error: "No session. Send init first." });
            return;
          }
          const readTools = createTools(session.workspace, session.containerId) as Record<string, any>;
          try {
            const result = await readTools.readFile.execute({ path: msg.path });
            send(ws, { type: "file-content", path: msg.path, _reqId: msg._reqId, ...result });
          } catch (err: any) {
            send(ws, { type: "file-content", path: msg.path, _reqId: msg._reqId, success: false, error: err.message });
          }
          break;
        }

        // ── Session management ──
        case "list-sessions": {
          if (!auth) {
            send(ws, { type: "error", error: "Not authenticated." });
            return;
          }
          const userSessions = listUserSessions(auth.userId, msg.limit || 50);
          send(ws, { type: "sessions-list", sessions: userSessions });
          break;
        }

        case "delete-session": {
          if (!auth) {
            send(ws, { type: "error", error: "Not authenticated." });
            return;
          }
          const deleted = deleteSession(msg.sessionId, auth.userId);
          send(ws, { type: "session-deleted", sessionId: msg.sessionId, success: deleted });
          break;
        }

        case "abort": {
          if (currentAbort) {
            currentAbort.abort();
            currentAbort = null;
          }
          break;
        }

        default:
          send(ws, { type: "error", error: `Unknown message type: ${msg.type}` });
      }
    } catch (err: any) {
      console.error("[WS] Error:", err.message);
      send(ws, { type: "error", error: `Server error: ${err.message}` });
    }
  });

  ws.on("close", () => {
    console.log("[WS] Client disconnected");
  });
});

function send(ws: WebSocket, data: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}
