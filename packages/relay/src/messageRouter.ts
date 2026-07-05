// ── 连接消息路由(从 index.ts 抽出,可测) ─────────────────────
// P6a:入站消息统一 RelayInbound.safeParse;注册强制 HMAC 鉴权;
// forward-response/stream、tunnel 回帧、heartbeat 与发送者身份绑定。

import { WebSocket } from "ws";
import { RelayInbound } from "@pocket-code/wire";
import { verifyDaemonAuth } from "./config.js";
import type { RequestTracker } from "./requestTracker.js";
import type { TunnelHub } from "./tunnelHub.js";
import {
  registerDaemon,
  updateHeartbeat,
  getOnlineMachines,
  forwardToDaemon,
  forwardToApp,
  forwardPairRequest,
  forwardPairResponse,
} from "./relay.js";

/** 每个 WS 连接的身份状态(注册/首个 app 消息时赋值) */
export interface ConnState {
  role: "unknown" | "daemon" | "app";
  machineId: string | null;
}

export function createConnState(): ConnState {
  return { role: "unknown", machineId: null };
}

export interface RouterDeps {
  relaySecret: string;
  requests: RequestTracker<WebSocket>;
  tunnelHub: TunnelHub;
  /** 可注入时钟(测试用) */
  now?: () => number;
}

function sendJSON(ws: WebSocket, data: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

/** 处理一条来自 App 或 Daemon 的原始 WS 消息。 */
export function handleRelayInbound(
  ws: WebSocket,
  raw: string,
  state: ConnState,
  deps: RouterDeps
): void {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    sendJSON(ws, { type: "error", error: "Invalid JSON" });
    return;
  }

  const parsed = RelayInbound.safeParse(json);
  if (!parsed.success) {
    const t = (json as Record<string, unknown> | null)?.type;
    // 配对请求格式非法时回 pair-response,App 配对 UI 才能显示失败
    if (t === "pair-request") {
      sendJSON(ws, { type: "pair-response", success: false, error: "Invalid pairing request format" });
    } else {
      console.warn(`[Relay] Rejected invalid message (type=${String(t)}): ${raw.slice(0, 200)}`);
      sendJSON(ws, { type: "error", error: `Invalid message${typeof t === "string" ? `: ${t}` : ""}` });
    }
    return;
  }
  const msg = parsed.data;

  switch (msg.type) {
    // ── Daemon 注册(强制 HMAC 鉴权) ──────────────
    case "daemon-register": {
      const auth = verifyDaemonAuth(
        deps.relaySecret,
        msg.machineId,
        msg.timestamp,
        msg.authToken,
        deps.now?.()
      );
      if (!auth.ok) {
        sendJSON(ws, { type: "error", error: auth.error });
        return;
      }
      // I-2:同一连接换 machineId 重复注册会在 daemons Map 里留下僵尸记录,拒绝之
      // (同 machineId 重复注册仍允许,属无害的重连语义)
      if (state.role === "daemon" && state.machineId && state.machineId !== msg.machineId) {
        sendJSON(ws, { type: "error", error: "Connection already registered as a different machine" });
        return;
      }
      state.role = "daemon";
      state.machineId = msg.machineId;
      registerDaemon(ws, msg.machineId, msg.machineName);
      sendJSON(ws, { type: "daemon-registered", machineId: msg.machineId });
      return;
    }

    // ── Daemon 心跳(只认本连接注册的 machineId) ──
    case "daemon-heartbeat": {
      if (state.role !== "daemon" || state.machineId !== msg.machineId) {
        console.warn(`[Relay] Dropped heartbeat for ${msg.machineId} from non-owner connection`);
        return;
      }
      updateHeartbeat(msg.machineId);
      return;
    }

    // ── Daemon 回帧(身份绑定:必须来自请求所属 daemon) ──
    case "forward-response":
    case "forward-stream": {
      if (state.role !== "daemon" || !state.machineId) return;
      const tracked = deps.requests.get(msg.requestId);
      if (!tracked) return;
      if (tracked.machineId !== state.machineId) {
        console.warn(
          `[Relay] Dropped forged ${msg.type} for request ${msg.requestId} from ${state.machineId}`
        );
        return;
      }
      if (msg.type === "forward-response") {
        forwardToApp(tracked.ws, "relay-response", msg.requestId, msg.payload);
        deps.requests.delete(msg.requestId);
      } else {
        forwardToApp(tracked.ws, "relay-stream", msg.requestId, msg.payload);
        // 流有多个分片,"done" 标志流结束才删,其余悬挂由 TTL 兜底
        if ((msg.payload as Record<string, unknown>)?.type === "done") {
          deps.requests.delete(msg.requestId);
        }
      }
      return;
    }

    // ── Daemon 配对响应(用本连接注册身份转发) ────
    case "pair-response": {
      if (state.role !== "daemon" || !state.machineId) return;
      forwardPairResponse(state.machineId, msg);
      return;
    }

    // ── Daemon 隧道回帧(归属校验在 TunnelHub 内) ──
    case "tunnel-response": {
      if (state.role !== "daemon" || !state.machineId) return;
      deps.tunnelHub.onResponse(msg.tunnelId, msg.status, msg.headers, state.machineId);
      return;
    }
    case "tunnel-chunk": {
      if (state.role !== "daemon" || !state.machineId) return;
      deps.tunnelHub.onChunk(msg.tunnelId, msg.data, state.machineId);
      return;
    }
    case "tunnel-end": {
      if (state.role !== "daemon" || !state.machineId) return;
      deps.tunnelHub.onEnd(msg.tunnelId, msg.error, state.machineId);
      return;
    }

    // ── App:发现在线机器 ─────────────────────────
    case "list-machines": {
      // I-1:已注册的 daemon 连接不得被 app 消息降级角色,否则断开时逃过清理
      if (state.role === "daemon") {
        console.warn(`[Relay] Dropped list-machines from registered daemon ${state.machineId}`);
        sendJSON(ws, { type: "error", error: "Daemon connection cannot send app messages" });
        return;
      }
      state.role = "app";
      sendJSON(ws, { type: "machines-list", machines: getOnlineMachines() });
      return;
    }

    // ── App:配对请求 ─────────────────────────────
    case "pair-request": {
      if (state.role === "daemon") {
        console.warn(`[Relay] Dropped pair-request from registered daemon ${state.machineId}`);
        sendJSON(ws, { type: "error", error: "Daemon connection cannot send app messages" });
        return;
      }
      state.role = "app";
      forwardPairRequest(ws, msg.pairingCode, msg.deviceId, msg.deviceName, msg.machineId);
      return;
    }

    // ── App:业务请求(记录归属 machineId) ─────────
    case "relay-request": {
      if (state.role === "daemon") {
        console.warn(`[Relay] Dropped relay-request from registered daemon ${state.machineId}`);
        sendJSON(ws, { type: "error", error: "Daemon connection cannot send app messages" });
        return;
      }
      state.role = "app";
      deps.requests.track(msg.requestId, ws, msg.machineId);
      const forwarded = forwardToDaemon(msg.machineId, msg.requestId, msg.token, msg.payload);
      if (!forwarded) {
        deps.requests.delete(msg.requestId);
        sendJSON(ws, {
          type: "relay-response",
          requestId: msg.requestId,
          payload: { type: "error", error: `Daemon ${msg.machineId} is not online.` },
        });
      }
      return;
    }
  }
}
