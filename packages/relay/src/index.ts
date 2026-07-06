// ── Relay Server Entry Point ──────────────────────────────
// Lightweight WebSocket relay that routes messages between
// mobile App clients and local Daemon processes.
// Does NOT execute any business logic — only auth and routing.

// 先加载 .env(cwd 下):RELAY_SECRET 等可写在文件里而不必 export;
// 真实环境变量优先于 .env(dotenv 默认不覆盖已存在的变量)。
import "dotenv/config";
import { WebSocketServer, WebSocket } from "ws";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import crypto from "crypto";
import {
  unregisterDaemon,
  getOnlineMachines,
  cleanupStaleDaemons,
  sendRawToDaemon,
} from "./relay.js";
import { RequestTracker } from "./requestTracker.js";
import { TunnelHub } from "./tunnelHub.js";
import { WsTunnelHub } from "./wsTunnelHub.js";
import { createUpgradeHandler, makeTunnelWss } from "./upgradeRouter.js";
import { requireRelaySecret } from "./config.js";
import { createConnState, handleRelayInbound } from "./messageRouter.js";

const PORT = parseInt(process.env.PORT || "3200", 10);

let RELAY_SECRET: string;
try {
  RELAY_SECRET = requireRelaySecret();
} catch (err: any) {
  console.error(`[Relay] 启动失败:${err.message}`);
  process.exit(1);
}

// ── 反向 HTTP 隧道枢纽(关联 http 请求与 tunnelId) ──
const tunnelHub = new TunnelHub();

// ── WS 隧道枢纽(P7 HMR,关联浏览器 ws 与 tunnelId) ──
const wsTunnelHub = new WsTunnelHub((machineId, frame) => {
  return sendRawToDaemon(machineId, frame);
});

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

    // 启动一条隧道:收齐请求体后转给 daemon。
    const startTunnel = (
      machineId: string,
      port: number,
      path: string,
      extraHeaders?: Record<string, string>
    ) => {
      const tunnelId = crypto.randomUUID();
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers[k] = v;
        else if (Array.isArray(v)) headers[k] = v.join(", ");
      }
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        const body = chunks.length ? Buffer.concat(chunks).toString("base64") : undefined;
        tunnelHub.open(tunnelId, res, machineId, extraHeaders);
        const ok = sendRawToDaemon(machineId, {
          type: "tunnel-request",
          tunnelId,
          port,
          method: req.method || "GET",
          path,
          headers,
          body,
        });
        if (!ok) tunnelHub.onEnd(tunnelId, `daemon ${machineId} offline`);
      });
    };

    // ── 显式隧道: /t/<machineId>/<port>/<rest> ──
    // 顺便下发 pc_tunnel cookie,使该页的「绝对路径子资源」(如 vite 的 /src/x)
    // 也能被路由回同一隧道(否则绝对路径会丢掉 /t/<id>/<port> 前缀而 404)。
    const tunnelMatch = url.pathname.match(/^\/t\/([^/]+)\/(\d+)(\/.*)?$/);
    if (tunnelMatch) {
      const [, machineId, portStr, rest] = tunnelMatch;
      const port = parseInt(portStr, 10);
      startTunnel(machineId, port, (rest || "/") + (url.search || ""), {
        "Set-Cookie": `pc_tunnel=${machineId}:${port}; Path=/; SameSite=Lax`,
      });
      return;
    }

    // ── 绝对路径子资源:靠 pc_tunnel cookie 路由回同一隧道 ──
    const cookieMatch = (req.headers.cookie || "").match(
      /(?:^|;\s*)pc_tunnel=([^:;]+):(\d+)/
    );
    if (cookieMatch) {
      startTunnel(cookieMatch[1], parseInt(cookieMatch[2], 10), url.pathname + (url.search || ""));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
  }
);

// ── WebSocket Server ──────────────────────────────────

const wss = new WebSocketServer({ noServer: true });
const tunnelWss = makeTunnelWss();
httpServer.on(
  "upgrade",
  createUpgradeHandler({
    controlWss: wss,
    tunnelWss,
    wsTunnelHub,
    sendToDaemon: sendRawToDaemon,
    port: PORT,
  })
);

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[Relay] Listening on ws://0.0.0.0:${PORT}`);
});

// Periodic heartbeat cleanup
setInterval(cleanupStaleDaemons, 20 * 1000);

// ── Connection Handling ───────────────────────────────

wss.on("connection", (ws: WebSocket) => {
  const state = createConnState();
  console.log("[Relay] New connection");

  ws.on("message", (raw: Buffer) => {
    handleRelayInbound(ws, raw.toString(), state, {
      relaySecret: RELAY_SECRET,
      requests,
      tunnelHub,
      wsTunnelHub,
    });
  });

  ws.on("close", () => {
    console.log(`[Relay] Connection closed (role: ${state.role})`);
    if (state.role === "daemon") {
      unregisterDaemon(ws);
      // 只中止该 daemon 的隧道(原 abortAll 全断)
      if (state.machineId) {
        tunnelHub.abortByMachine(state.machineId);
        wsTunnelHub.abortByMachine(state.machineId);
      }
    }
    if (state.role === "app") {
      requests.deleteBySocket(ws);
    }
  });
});

// ── Request tracking ──────────────────────────────────
// Maps requestId → App WebSocket(带 TTL),so daemon responses can be routed back.

const requests = new RequestTracker<WebSocket>();

// 每 60s 清理:已关闭 socket 或超 TTL 的悬挂请求(修复原内存泄漏)。
setInterval(() => {
  requests.cleanupStale();
}, 60 * 1000);
