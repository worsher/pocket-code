// ── Relay Server Entry Point ──────────────────────────────
// Lightweight WebSocket relay that routes messages between
// mobile App clients and local Daemon processes.
// Does NOT execute any business logic — only auth and routing.

import { WebSocketServer, WebSocket } from "ws";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import crypto from "crypto";
import {
  registerDaemon,
  unregisterDaemon,
  updateHeartbeat,
  getOnlineMachines,
  forwardToDaemon,
  forwardToApp,
  forwardPairRequest,
  forwardPairResponse,
  cleanupStaleDaemons,
} from "./relay.js";

const PORT = parseInt(process.env.PORT || "3200", 10);
const RELAY_SECRET = process.env.RELAY_SECRET || "";
const HMAC_TIME_WINDOW_MS = 5 * 60 * 1000; // 5 minutes for replay prevention

// ── HTTP Server (health check only) ──────────────────

const httpServer = createServer(
  (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Access-Control-Allow-Origin", "*");

    const url = new URL(req.url || "", `http://localhost:${PORT}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          timestamp: Date.now(),
          machines: getOnlineMachines().length,
        })
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
  }
);

// ── WebSocket Server ──────────────────────────────────

const wss = new WebSocketServer({ server: httpServer });

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[Relay] Listening on ws://0.0.0.0:${PORT}`);
});

// Periodic heartbeat cleanup
setInterval(cleanupStaleDaemons, 20 * 1000);

// ── Connection Handling ───────────────────────────────

function sendJSON(ws: WebSocket, data: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

wss.on("connection", (ws: WebSocket) => {
  // Track what this socket represents
  let role: "unknown" | "daemon" | "app" = "unknown";
  let machineId: string | null = null;

  console.log("[Relay] New connection");

  ws.on("message", (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());

      switch (msg.type) {
        // ── Daemon registration ──────────────────────
        case "daemon-register": {
          if (!msg.machineId || !msg.machineName) {
            sendJSON(ws, {
              type: "error",
              error: "machineId and machineName are required",
            });
            return;
          }

          // Verify HMAC if RELAY_SECRET is configured
          if (RELAY_SECRET) {
            if (!msg.authToken || !msg.timestamp) {
              sendJSON(ws, {
                type: "error",
                error: "Registration requires authToken and timestamp when RELAY_SECRET is set.",
              });
              return;
            }

            // Replay prevention: reject timestamps outside the time window
            const now = Date.now();
            if (Math.abs(now - msg.timestamp) > HMAC_TIME_WINDOW_MS) {
              sendJSON(ws, {
                type: "error",
                error: "Registration timestamp expired. Check system clock sync.",
              });
              return;
            }

            // Verify HMAC-SHA256(machineId + timestamp, RELAY_SECRET)
            const expectedHmac = crypto
              .createHmac("sha256", RELAY_SECRET)
              .update(msg.machineId + msg.timestamp)
              .digest("hex");

            if (!crypto.timingSafeEqual(
              Buffer.from(msg.authToken, "hex"),
              Buffer.from(expectedHmac, "hex")
            )) {
              sendJSON(ws, {
                type: "error",
                error: "Invalid authToken. RELAY_SECRET mismatch.",
              });
              return;
            }
          }

          role = "daemon";
          machineId = msg.machineId;
          registerDaemon(ws, msg.machineId, msg.machineName);
          sendJSON(ws, {
            type: "daemon-registered",
            machineId: msg.machineId,
          });
          break;
        }

        // ── Daemon heartbeat ─────────────────────────
        case "daemon-heartbeat": {
          if (msg.machineId) {
            updateHeartbeat(msg.machineId);
          }
          break;
        }

        // ── Daemon responses (forward to App) ────────
        case "forward-response": {
          if (role !== "daemon" || !msg.requestId) return;
          // We need the appSocket — find it by tracking
          // The relay-request handler stores the appSocket per requestId
          const appSocket = requestMap.get(msg.requestId);
          if (appSocket) {
            forwardToApp(appSocket, "relay-response", msg.requestId, msg.payload);
            requestMap.delete(msg.requestId);
          }
          break;
        }

        case "forward-stream": {
          if (role !== "daemon" || !msg.requestId) return;
          const streamAppSocket = requestMap.get(msg.requestId);
          if (streamAppSocket) {
            forwardToApp(
              streamAppSocket,
              "relay-stream",
              msg.requestId,
              msg.payload
            );
            // Don't delete from requestMap — stream has multiple chunks
            // The "done" payload signals end of stream, cleanup happens via
            // payload inspection or a timeout
            if (msg.payload?.type === "done") {
              requestMap.delete(msg.requestId);
            }
          }
          break;
        }

        // ── Daemon pair-response ─────────────────────
        case "pair-response": {
          if (role !== "daemon" || !machineId) return;
          forwardPairResponse(machineId, msg);
          break;
        }

        // ── App: list online machines ────────────────
        case "list-machines": {
          role = "app";
          const machines = getOnlineMachines();
          sendJSON(ws, { type: "machines-list", machines });
          break;
        }

        // ── App: pair request ────────────────────────
        case "pair-request": {
          role = "app";
          if (!msg.pairingCode || !msg.deviceId || !msg.deviceName) {
            sendJSON(ws, {
              type: "pair-response",
              success: false,
              error: "pairingCode, deviceId, and deviceName are required",
            });
            return;
          }
          forwardPairRequest(
            ws,
            msg.pairingCode,
            msg.deviceId,
            msg.deviceName,
            msg.machineId
          );
          break;
        }

        // ── App: relay-request (business message) ────
        case "relay-request": {
          role = "app";
          if (!msg.token || !msg.machineId || !msg.requestId || !msg.payload) {
            sendJSON(ws, {
              type: "error",
              error: "token, machineId, requestId, and payload are required",
            });
            return;
          }

          // Track this request so we can route daemon responses back
          requestMap.set(msg.requestId, ws);

          const forwarded = forwardToDaemon(
            msg.machineId,
            msg.requestId,
            msg.token,
            msg.payload
          );

          if (!forwarded) {
            requestMap.delete(msg.requestId);
            sendJSON(ws, {
              type: "relay-response",
              requestId: msg.requestId,
              payload: {
                type: "error",
                error: `Daemon ${msg.machineId} is not online.`,
              },
            });
          }
          break;
        }

        default: {
          sendJSON(ws, {
            type: "error",
            error: `Unknown message type: ${msg.type}`,
          });
        }
      }
    } catch (err: any) {
      console.error("[Relay] Parse error:", err.message);
      sendJSON(ws, { type: "error", error: "Invalid JSON" });
    }
  });

  ws.on("close", () => {
    console.log(`[Relay] Connection closed (role: ${role})`);
    if (role === "daemon") {
      unregisterDaemon(ws);
    }
    // Cleanup any pending requests from this app socket
    if (role === "app") {
      for (const [reqId, sock] of requestMap) {
        if (sock === ws) {
          requestMap.delete(reqId);
        }
      }
    }
  });
});

// ── Request tracking ──────────────────────────────────
// Maps requestId → App WebSocket, so daemon responses can be routed back.

const requestMap = new Map<string, WebSocket>();

// Cleanup stale request mappings every 5 minutes
setInterval(() => {
  // We can't easily know which requests are stale without timestamps,
  // but closed sockets will be caught here
  for (const [reqId, sock] of requestMap) {
    if (sock.readyState !== WebSocket.OPEN) {
      requestMap.delete(reqId);
    }
  }
}, 5 * 60 * 1000);
