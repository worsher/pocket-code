import { WebSocketServer, WebSocket } from "ws";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { handleOAuthRoute } from "./oauth.js";
import { handleFileUpload, handleFileDownload, handleWorkspaceSync } from "./fileTransfer.js";
import { isPoolEnabled, initPool } from "./containerPool.js";
import { initDb } from "./db.js";
import { createMessageHandler } from "./messageHandler.js";

const PORT = parseInt(process.env.PORT || "3100", 10);

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
  if (url.pathname === "/api/workspace/sync" && req.method === "GET") {
    await handleWorkspaceSync(req, res, url);
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not Found" }));
});

// ── WebSocket Server ──────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer });
httpServer.listen(PORT, () => {
  console.log(`Pocket Code server listening on ws://localhost:${PORT} (HTTP+WS)`);
});

function send(ws: WebSocket, data: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

wss.on("connection", (ws: WebSocket) => {
  console.log("[WS] Client connected");

  const handler = createMessageHandler((data) => send(ws, data));

  ws.on("message", async (raw: Buffer) => {
    await handler.onMessage(raw);
  });

  ws.on("close", () => {
    console.log("[WS] Client disconnected");
    handler.onClose();
  });
});
