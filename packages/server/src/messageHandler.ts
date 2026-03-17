// ── Message Handler ───────────────────────────────────────
// Transport-agnostic message processing logic extracted from index.ts.
// Used by both the direct WebSocket server (index.ts) and the relay daemon.

import { createSession, runAgent, type AgentSession } from "./agent.js";
import { createTools, getWorkspaceRoot } from "./tools.js";
import { setupGitCredentials } from "./gitCredentials.js";
import { verifyToken, registerAnonymous, type AuthPayload } from "./auth.js";
import { isDockerEnabled, getContainer } from "./docker.js";
import { initDb, listUserSessions, deleteSession } from "./db.js";
import { checkQuota, incrementUsage, getUserQuota } from "./resourceLimits.js";
import { WsMessage } from "./wsSchemas.js";
import { rm } from "fs/promises";

// Shared session store — the same Map is used for all handlers
const sessions = new Map<string, AgentSession>();

// TTL cleanup: remove sessions idle for more than 30 minutes
const SESSION_TTL_MS = 30 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, sess] of sessions) {
    if (now - (sess.lastActivity || 0) > SESSION_TTL_MS) {
      sessions.delete(id);
      console.log(`[Session] Cleaned up stale session: ${id}`);
    }
  }
}, 5 * 60 * 1000);

export interface MessageHandler {
  onMessage(raw: string | Buffer): Promise<void>;
  onClose(): void;
}

export interface MessageHandlerOptions {
  /** Pre-injected auth (used by Daemon relay mode to bypass token verification) */
  preAuth?: AuthPayload;
}

/**
 * Create a transport-agnostic message handler.
 *
 * @param send - Callback to send a response back to the client.
 *               The handler doesn't care if this goes to a direct WS or through a relay.
 * @param options - Optional configuration including pre-injected auth.
 */
export function createMessageHandler(
  send: (data: unknown) => void,
  options?: MessageHandlerOptions
): MessageHandler {
  let session: AgentSession | null = null;
  let currentAbort: AbortController | null = null;
  let auth: AuthPayload | null = options?.preAuth || null;
  let activeSessionId: string | null = null;

  return {
    async onMessage(raw: string | Buffer) {
      try {
        const raw_msg = JSON.parse(raw.toString());
        const parsed = WsMessage.safeParse(raw_msg);
        if (!parsed.success) {
          const errMsg = parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ");
          console.log(
            "[Handler] Validation failed for type:",
            raw_msg?.type,
            "errors:",
            errMsg
          );
          send({ type: "error", error: `Invalid message: ${errMsg}` });
          return;
        }
        const msg = parsed.data;
        console.log("[Handler] Received:", msg.type);

        switch (msg.type) {
          // ── Anonymous registration ─────────────────────
          case "register": {
            console.log(
              "[Handler] Processing register, deviceId:",
              msg.deviceId
            );
            const deviceId = msg.deviceId;
            if (!deviceId) {
              send({ type: "error", error: "deviceId is required" });
              return;
            }
            const result = registerAnonymous(deviceId);
            if ("error" in result) {
              send({ type: "error", error: result.error });
              return;
            }
            console.log("[Handler] Register success, userId:", result.userId);
            send({
              type: "auth",
              token: result.token,
              userId: result.userId,
            });
            break;
          }

          // ── Session init (requires auth) ───────────────
          case "init": {
            console.log(
              "[Handler] Processing init, token present:",
              !!msg.token,
              "sessionId:",
              msg.sessionId,
              "preAuth:",
              !!auth
            );
            // Only verify token if auth is not already pre-injected
            if (msg.token && !auth) {
              auth = verifyToken(msg.token);
            }
            if (!auth) {
              console.log("[Handler] Init failed: invalid or missing token");
              send({
                type: "error",
                error: "Invalid or missing token. Send register first.",
              });
              return;
            }
            console.log("[Handler] Auth verified, userId:", auth.userId);

            const sessionId = msg.sessionId || crypto.randomUUID();
            const projectId: string = msg.projectId || "";
            if (sessions.has(sessionId)) {
              session = sessions.get(sessionId)!;
              if (session.userId !== auth.userId) {
                send({
                  type: "error",
                  error: "Session does not belong to this user.",
                });
                session = null;
                return;
              }
            } else {
              session = await createSession(sessionId, auth.userId, projectId);
              sessions.set(sessionId, session);
            }
            activeSessionId = sessionId;
            session.lastActivity = Date.now();

            // Docker isolation
            if (isDockerEnabled() && !session.containerId) {
              try {
                session.containerId = await getContainer(
                  auth.userId,
                  session.workspace
                );
                console.log(
                  `[Handler] Docker container: ${session.containerId.slice(0, 12)}`
                );
              } catch (err: any) {
                console.error(
                  "[Handler] Failed to create Docker container:",
                  err.message
                );
              }
            }
            if (msg.model) {
              session.modelKey = msg.model;
            }
            if (msg.customPrompt !== undefined) {
              session.customPrompt = msg.customPrompt || undefined;
            }
            if (msg.gitCredentials && msg.gitCredentials.length > 0) {
              try {
                await setupGitCredentials(
                  session.workspace,
                  msg.gitCredentials as any
                );
              } catch (err: any) {
                console.error(
                  "[Handler] Failed to setup git credentials:",
                  err.message
                );
              }
            }
            send({
              type: "session",
              sessionId: session.sessionId,
              projectId: session.projectId,
              workspace: session.workspace,
            });
            break;
          }

          case "message": {
            if (!session) {
              send({ type: "error", error: "No session. Send init first." });
              return;
            }
            session.lastActivity = Date.now();
            if (auth) {
              const quotaCheck = checkQuota(auth.userId, "api_call");
              if (!quotaCheck.allowed) {
                send({ type: "error", error: quotaCheck.reason });
                send({ type: "done" });
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

            // Conversation branching
            if (typeof msg.rewindTo === "number" && msg.rewindTo >= 0) {
              session.messages = session.messages.slice(0, msg.rewindTo);
            }

            const abort = new AbortController();
            currentAbort = abort;
            await runAgent(
              session,
              msg.content,
              (event) => {
                send(event);
              },
              abort.signal,
              msg.images
            );
            currentAbort = null;
            break;
          }

          case "get-quota": {
            if (!auth) {
              send({ type: "error", error: "Not authenticated." });
              return;
            }
            const quota = getUserQuota(auth.userId);
            send({ type: "quota", ...quota });
            break;
          }

          // ── Geek mode: execute a single tool on demand ──
          case "tool-exec": {
            if (!session) {
              send({ type: "error", error: "No session. Send init first." });
              return;
            }
            const { toolName, args, callId } = msg;
            const tools = createTools(
              session.workspace,
              session.containerId
            );
            const toolFn = (tools as Record<string, any>)[toolName];
            if (!toolFn) {
              send({
                type: "tool-result",
                callId,
                toolName,
                result: { success: false, error: `Unknown tool: ${toolName}` },
              });
              break;
            }
            try {
              const result = await toolFn.execute(args);
              send({ type: "tool-result", callId, toolName, result });
            } catch (err: any) {
              send({
                type: "tool-result",
                callId,
                toolName,
                result: { success: false, error: err.message },
              });
            }
            break;
          }

          // ── File operations ──
          case "list-files": {
            if (!session) {
              send({ type: "error", error: "No session. Send init first." });
              return;
            }
            const listTools = createTools(
              session.workspace,
              session.containerId
            ) as Record<string, any>;
            try {
              const result = await listTools.listFiles.execute({
                path: msg.path || ".",
              });
              send({
                type: "file-list",
                path: msg.path || ".",
                _reqId: msg._reqId,
                ...result,
              });
            } catch (err: any) {
              send({
                type: "file-list",
                path: msg.path || ".",
                _reqId: msg._reqId,
                success: false,
                error: err.message,
              });
            }
            break;
          }

          case "read-file": {
            if (!session) {
              send({ type: "error", error: "No session. Send init first." });
              return;
            }
            const readTools = createTools(
              session.workspace,
              session.containerId
            ) as Record<string, any>;
            try {
              const result = await readTools.readFile.execute({
                path: msg.path,
              });
              send({
                type: "file-content",
                path: msg.path,
                _reqId: msg._reqId,
                ...result,
              });
            } catch (err: any) {
              send({
                type: "file-content",
                path: msg.path,
                _reqId: msg._reqId,
                success: false,
                error: err.message,
              });
            }
            break;
          }

          // ── Session management ──
          case "list-sessions": {
            if (!auth) {
              send({ type: "error", error: "Not authenticated." });
              return;
            }
            const projectFilter: string | undefined =
              msg.projectId || undefined;
            const userSessions = listUserSessions(
              auth.userId,
              msg.limit || 50,
              projectFilter
            );
            send({ type: "sessions-list", sessions: userSessions });
            break;
          }

          case "delete-session": {
            if (!auth) {
              send({ type: "error", error: "Not authenticated." });
              return;
            }
            const deleted = deleteSession(msg.sessionId, auth.userId);
            send({
              type: "session-deleted",
              sessionId: msg.sessionId,
              success: deleted,
            });
            break;
          }

          case "delete-project-workspace": {
            if (!auth) {
              send({ type: "error", error: "Not authenticated." });
              return;
            }
            const { projectId: delProjectId } = msg;
            if (!delProjectId) {
              send({ type: "error", error: "projectId is required." });
              return;
            }
            const projectSessions = listUserSessions(
              auth.userId,
              1,
              delProjectId
            );
            if (projectSessions.length === 0) {
              send({
                type: "project-workspace-deleted",
                projectId: delProjectId,
                success: false,
                error: "No sessions found for this project.",
              });
              return;
            }
            const workspacePath = getWorkspaceRoot("", delProjectId);
            try {
              await rm(workspacePath, { recursive: true, force: true });
              send({
                type: "project-workspace-deleted",
                projectId: delProjectId,
                success: true,
              });
            } catch (err: any) {
              send({
                type: "project-workspace-deleted",
                projectId: delProjectId,
                success: false,
                error: err.message,
              });
            }
            break;
          }

          case "abort": {
            if (currentAbort) {
              currentAbort.abort();
              currentAbort = null;
            }
            break;
          }

          default: {
            send({
              type: "error",
              error: `Unknown message type: ${(msg as any).type}`,
            });
          }
        }
      } catch (err: any) {
        console.error("[Handler] Error:", err.message);
        send({ type: "error", error: `Server error: ${err.message}` });
      }
    },

    onClose() {
      if (currentAbort) {
        currentAbort.abort();
        currentAbort = null;
      }
      session = null;
      auth = null;
      activeSessionId = null;
    },
  };
}
