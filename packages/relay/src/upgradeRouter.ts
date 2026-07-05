// ── upgrade 路由(P7 HMR) ────────────────────────────────────
// 原 new WebSocketServer({ server }) 会吃掉所有 upgrade,隧道路径的
// WS 握手(vite HMR 等)因此失败。拆分:/t 显式路径或 pc_tunnel cookie
// → WS 隧道;其余 → 控制通道(App/daemon,行为不变)。

import crypto from "crypto";
import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { WsTunnelHub } from "./wsTunnelHub.js";

const TUNNEL_PATH_RE = /^\/t\/([^/]+)\/(\d+)(\/.*)?$/;
const TUNNEL_COOKIE_RE = /(?:^|;\s*)pc_tunnel=([^:;]+):(\d+)/;

export interface UpgradeDeps {
  controlWss: WebSocketServer;
  tunnelWss: WebSocketServer;
  wsTunnelHub: WsTunnelHub;
  sendToDaemon: (machineId: string, frame: unknown) => boolean;
  port: number;
}

/** 隧道握手用 WSS:回显浏览器请求的首个子协议(vite 的 "vite-hmr" 等)。 */
export function makeTunnelWss(): WebSocketServer {
  return new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => {
      const first = protocols.values().next().value;
      return first ?? false;
    },
  });
}

export function createUpgradeHandler(deps: UpgradeDeps) {
  return (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = new URL(req.url || "", `http://localhost:${deps.port || 80}`);

    let machineId: string | null = null;
    let port = 0;
    let path = "";

    const m = url.pathname.match(TUNNEL_PATH_RE);
    if (m) {
      machineId = m[1];
      port = parseInt(m[2], 10);
      path = (m[3] || "/") + (url.search || "");
    } else {
      const c = (req.headers.cookie || "").match(TUNNEL_COOKIE_RE);
      if (c) {
        machineId = c[1];
        port = parseInt(c[2], 10);
        path = url.pathname + (url.search || "");
      }
    }

    if (!machineId) {
      // 控制通道(App/daemon):行为与原 { server } 挂载完全一致
      deps.controlWss.handleUpgrade(req, socket, head, (ws) => {
        deps.controlWss.emit("connection", ws, req);
      });
      return;
    }

    // ── WS 隧道 ──
    deps.tunnelWss.handleUpgrade(req, socket, head, (browserWs: WebSocket) => {
      const tunnelId = `ws_${crypto.randomUUID()}`;
      const headers: Record<string, string> = {};
      if (req.headers.cookie) headers["cookie"] = req.headers.cookie;
      if (typeof req.headers["sec-websocket-protocol"] === "string") {
        headers["sec-websocket-protocol"] = req.headers["sec-websocket-protocol"];
      }
      if (typeof req.headers["user-agent"] === "string") {
        headers["user-agent"] = req.headers["user-agent"];
      }

      deps.wsTunnelHub.open(tunnelId, browserWs, machineId!);
      const ok = deps.sendToDaemon(machineId!, {
        type: "tunnel-ws-open",
        tunnelId,
        port,
        path,
        headers,
      });
      if (!ok) deps.wsTunnelHub.onClose(tunnelId, 1013, `daemon ${machineId} offline`);
    });
  };
}
