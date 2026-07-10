// ── Relay Server Entry Point ──────────────────────────────
// Lightweight WebSocket relay that routes messages between
// mobile App clients and local Daemon processes.
// Does NOT execute any business logic — only auth and routing.

// 加载 .env:依次尝试 cwd → 包根 → 仓库根(已存在的变量不被覆盖)。
// pnpm --filter 运行时 cwd 是包目录,直接跑 dist 时 cwd 可能是仓库根,三级都兜住。
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join as joinPath } from "path";
loadEnv();
{
  const here = dirname(fileURLToPath(import.meta.url)); // src/ 或 dist/
  loadEnv({ path: joinPath(here, "..", ".env") });               // 包根
  loadEnv({ path: joinPath(here, "..", "..", "..", ".env") });   // 仓库根
}
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";
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
import { createHttpHandler } from "./httpRouter.js";
import { requireRelaySecret, isDiscoveryEnabled, getTunnelToken, isTunnelCookieSecure, getTunnelMode, getTunnelBaseDomain } from "./config.js";
import { createConnState, handleRelayInbound } from "./messageRouter.js";

const PORT = parseInt(process.env.PORT || "3200", 10);

let RELAY_SECRET: string;
try {
  RELAY_SECRET = requireRelaySecret();
} catch (err: any) {
  console.error(`[Relay] 启动失败:${err.message}`);
  process.exit(1);
}

const DISCOVERY = isDiscoveryEnabled();
console.log(`[Relay] Discovery: ${DISCOVERY ? "on" : "off"}`);

const TUNNEL_TOKEN = getTunnelToken();
const TUNNEL_COOKIE_SECURE = isTunnelCookieSecure();
console.log(
  `[Relay] Tunnel ingress auth: ${TUNNEL_TOKEN ? `TUNNEL_TOKEN required (cookie Secure: ${TUNNEL_COOKIE_SECURE ? "on" : "off"})` : "open (machineId is the capability)"}`
);

const TUNNEL_MODE = getTunnelMode();
const TUNNEL_BASE_DOMAIN = getTunnelBaseDomain();
if (TUNNEL_MODE === "subdomain" && TUNNEL_BASE_DOMAIN === null) {
  console.error("[Relay] 启动失败:TUNNEL_BASE_DOMAIN required when TUNNEL_MODE=subdomain (e.g. tunnel.example.com)");
  process.exit(1);
}
console.log(`[Relay] Tunnel mode: ${TUNNEL_MODE}${TUNNEL_MODE === "subdomain" ? ` (base=${TUNNEL_BASE_DOMAIN})` : ""}`);

// ── 反向 HTTP 隧道枢纽(关联 http 请求与 tunnelId) ──
const tunnelHub = new TunnelHub();

// ── WS 隧道枢纽(P7 HMR,关联浏览器 ws 与 tunnelId) ──
const wsTunnelHub = new WsTunnelHub((machineId, frame) => {
  return sendRawToDaemon(machineId, frame);
});

// ── HTTP Server (health check + reverse tunnel routing) ──

const httpServer = createServer(
  createHttpHandler({
    tunnelHub,
    sendToDaemon: sendRawToDaemon,
    getOnlineMachineCount: () => getOnlineMachines().length,
    port: PORT,
    tunnelToken: TUNNEL_TOKEN,
    tunnelCookieSecure: TUNNEL_COOKIE_SECURE,
    tunnelMode: TUNNEL_MODE,
    tunnelBaseDomain: TUNNEL_BASE_DOMAIN,
  })
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
    tunnelToken: TUNNEL_TOKEN,
  })
);

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[Relay] Listening on ws://0.0.0.0:${PORT}`);
});

// Periodic heartbeat cleanup
setInterval(cleanupStaleDaemons, 20 * 1000);

// ── Connection Handling ───────────────────────────────

wss.on("connection", (ws: WebSocket, req) => {
  const state = createConnState();
  const remote = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
  const ua = req.headers["user-agent"] || "-";
  console.log(`[Relay] New connection from ${remote} ua=${ua}`);

  ws.on("message", (raw: Buffer) => {
    handleRelayInbound(ws, raw.toString(), state, {
      relaySecret: RELAY_SECRET,
      requests,
      tunnelHub,
      wsTunnelHub,
      discovery: DISCOVERY,
    });
  });

  ws.on("close", (code: number, reason: Buffer) => {
    console.log(
      `[Relay] Connection closed (role: ${state.role}, code: ${code}, reason: ${reason.toString() || "-"})`
    );
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
