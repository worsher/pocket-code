import { WebSocketServer, WebSocket } from "ws";
import { createSession, runAgent, type AgentSession } from "./agent.js";

const PORT = parseInt(process.env.PORT || "3100", 10);

const wss = new WebSocketServer({ port: PORT });
const sessions = new Map<string, AgentSession>();

console.log(`Pocket Code server listening on ws://localhost:${PORT}`);

wss.on("connection", (ws: WebSocket) => {
  let session: AgentSession | null = null;
  console.log("[WS] Client connected");

  ws.on("message", async (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());
      console.log("[WS] Received:", msg.type);

      switch (msg.type) {
        case "init": {
          const sessionId = msg.sessionId || crypto.randomUUID();
          if (sessions.has(sessionId)) {
            session = sessions.get(sessionId)!;
          } else {
            session = await createSession(sessionId);
            sessions.set(sessionId, session);
          }
          if (msg.model) {
            session.modelKey = msg.model;
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
          if (msg.model) {
            session.modelKey = msg.model;
          }

          await runAgent(session, msg.content, (event) => {
            send(ws, event);
          });
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
