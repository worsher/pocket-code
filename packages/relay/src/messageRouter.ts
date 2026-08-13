// ── 连接消息路由(从 index.ts 抽出,可测) ─────────────────────
// P6a:入站消息统一 RelayInbound.safeParse;注册强制 HMAC 鉴权;
// forward-response/stream、tunnel 回帧、heartbeat 与发送者身份绑定。

import { WebSocket } from "ws";
import { RelayInbound } from "@pocket-code/protocol-core";
import { verifyDaemonAuth } from "./config.js";
import { relayLog } from "./log.js";
import type { RequestTracker } from "./requestTracker.js";
import type { TunnelHub } from "./tunnelHub.js";
import { WsTunnelHub } from "./wsTunnelHub.js";
import {
  registerDaemon,
  isDaemonOwner,
  updateHeartbeat,
  getOnlineMachines,
  forwardToDaemon,
  forwardToApp,
  forwardPairRequest,
  forwardPairResponse,
} from "./relay.js";
import { releaseDaemonResources } from "./connectionLifecycle.js";

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
  wsTunnelHub: WsTunnelHub;
  /** 可注入时钟(测试用) */
  now?: () => number;
  /** 发现与配对转发开关(RELAY_DISCOVERY);false 才关闭,undefined 视为开启 */
  discovery?: boolean;
}

function sendJSON(ws: WebSocket, data: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

const SINGLE_RESPONSE_BY_REQUEST = new Map<string, string>([
  ["register", "auth"],
  ["get-quota", "quota"],
  ["tool-exec", "tool-result"],
  ["list-files", "file-list"],
  ["read-file", "file-content"],
  ["sync-pull", "sync-manifest"],
  ["sync-file", "sync-file-content"],
  ["workspace-writer-release", "workspace-writer-released"],
  ["list-sessions", "sessions-list"],
  ["delete-session", "session-deleted"],
  ["delete-project-workspace", "project-workspace-deleted"],
  ["workspace-import-git", "workspace-import-result"],
  ["workspace-bind-linked", "workspace-import-result"],
  ["workspace-source-inspect", "workspace-source-status"],
  ["workspace-legacy-cleanup", "workspace-legacy-cleaned"],
  ["git-credential-upsert", "git-credential-result"],
  ["git-credential-test", "git-credential-result"],
  ["git-credential-delete", "git-credential-result"],
  ["git-workspace-operation", "git-operation-result"],
]);

function payloadRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
}

function isTerminalGoalUpdate(payload: Record<string, unknown>): boolean {
  if (payload.type !== "goal-updated") return false;
  if (payload.change === "completion" || payload.change === "cleared") return true;
  return (
    payload.change === "lifecycle" && (payload.status === "paused" || payload.status === "blocked")
  );
}

function isCorrelatedControlError(payload: Record<string, unknown>): boolean {
  // ServerError uses `error`; AgentEvent error uses `message` and is followed
  // by done or a goal lifecycle event.
  return payload.type === "error" && typeof payload.error === "string";
}

function isGoalTerminalError(payload: Record<string, unknown>): boolean {
  return (
    payload.type === "error" &&
    (payload.code === "goal-resume-unavailable" || payload.code === "goal-recovery-unavailable")
  );
}

function completeStreamFrame(
  deps: RouterDeps,
  requestId: string,
  tracked: NonNullable<ReturnType<RouterDeps["requests"]["get"]>>,
  payload: Record<string, unknown>
): void {
  const now = deps.now?.();
  let requestType = tracked.requestType;

  // If Relay was restarted, init can only recreate an untyped active-turn
  // entry. A goal lifecycle frame identifies it before any intermediate done.
  if (requestType === "active-turn" && payload.type === "goal-updated") {
    requestType = "goal-control";
    deps.requests.setRequestType(requestId, requestType, now);
  }

  if (payload.type === "session-ready") {
    deps.requests.completeInit(requestId, now);
    return;
  }

  if (isCorrelatedControlError(payload)) {
    deps.requests.completeRequest(requestId, now);
    return;
  }

  if (SINGLE_RESPONSE_BY_REQUEST.get(requestType ?? "") === payload.type) {
    deps.requests.completeRequest(requestId, now);
    return;
  }

  if (requestType === "goal-create" || requestType === "goal-control") {
    if (isTerminalGoalUpdate(payload)) {
      deps.requests.completeRequest(requestId, now);
      return;
    }
    if (isGoalTerminalError(payload)) {
      deps.requests.markDeleteAfterDone(requestId, now);
      return;
    }
    if (payload.type === "done" && tracked.deleteAfterDone) {
      deps.requests.completeRequest(requestId, now);
    }
    return;
  }

  if (payload.type === "done" && (requestType === "message" || requestType === "active-turn")) {
    deps.requests.completeRequest(requestId, now);
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
      relayLog("Rejected invalid pair-request format");
      sendJSON(ws, {
        type: "pair-response",
        success: false,
        error: "Invalid pairing request format",
      });
    } else {
      // Malformed envelopes may still contain credentials; never log raw frames.
      console.warn(`[Relay] Rejected invalid message (type=${String(t)})`);
      sendJSON(ws, {
        type: "error",
        error: `Invalid message${typeof t === "string" ? `: ${t}` : ""}`,
      });
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
        sendJSON(ws, {
          type: "error",
          error: "Connection already registered as a different machine",
        });
        return;
      }
      state.role = "daemon";
      state.machineId = msg.machineId;
      const replacedSocket = registerDaemon(
        ws,
        msg.machineId,
        msg.machineName,
        msg.publicKey,
        msg.keyId
      );
      if (replacedSocket) {
        // Registration runs synchronously, so every tracked request at this point
        // belongs to the replaced daemon generation. End those waiters before any
        // request can be routed to the new owner.
        releaseDaemonResources(msg.machineId, deps);
      }
      sendJSON(ws, { type: "daemon-registered", machineId: msg.machineId });
      return;
    }

    // ── Daemon 心跳(只认本连接注册的 machineId) ──
    case "daemon-heartbeat": {
      if (
        state.role !== "daemon" ||
        state.machineId !== msg.machineId ||
        !isDaemonOwner(ws, msg.machineId)
      ) {
        console.warn(`[Relay] Dropped heartbeat for ${msg.machineId} from non-owner connection`);
        return;
      }
      updateHeartbeat(msg.machineId);
      return;
    }

    // ── Daemon 回帧(身份绑定:必须来自请求所属 daemon) ──
    case "forward-response":
    case "forward-stream": {
      if (state.role !== "daemon" || !state.machineId || !isDaemonOwner(ws, state.machineId))
        return;
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
        if (payloadRecord(msg.payload).type === "session-ready") {
          deps.requests.completeInit(msg.requestId, deps.now?.());
        } else {
          // Daemon reserves forward-response for terminal control replies and
          // handler failures. Goal/agent progress always uses forward-stream.
          deps.requests.completeRequest(msg.requestId, deps.now?.());
        }
      } else {
        forwardToApp(tracked.ws, "relay-stream", msg.requestId, msg.payload);
        deps.requests.touch(msg.requestId, deps.now?.());
        completeStreamFrame(deps, msg.requestId, tracked, payloadRecord(msg.payload));
      }
      return;
    }

    // ── Daemon 配对响应(用本连接注册身份转发) ────
    case "pair-response": {
      if (state.role !== "daemon" || !state.machineId || !isDaemonOwner(ws, state.machineId))
        return;
      forwardPairResponse(state.machineId, msg);
      return;
    }

    // ── Daemon 隧道回帧(归属校验在 TunnelHub 内) ──
    case "tunnel-response": {
      if (state.role !== "daemon" || !state.machineId || !isDaemonOwner(ws, state.machineId))
        return;
      deps.tunnelHub.onResponse(msg.tunnelId, msg.status, msg.headers, state.machineId);
      return;
    }
    case "tunnel-chunk": {
      if (state.role !== "daemon" || !state.machineId || !isDaemonOwner(ws, state.machineId))
        return;
      deps.tunnelHub.onChunk(msg.tunnelId, msg.data, state.machineId);
      return;
    }
    case "tunnel-end": {
      if (state.role !== "daemon" || !state.machineId || !isDaemonOwner(ws, state.machineId))
        return;
      deps.tunnelHub.onEnd(msg.tunnelId, msg.error, state.machineId);
      return;
    }

    // ── Daemon WS 隧道回帧(P7 HMR,归属校验在 WsTunnelHub 内) ──
    case "tunnel-ws-opened": {
      if (state.role !== "daemon" || !state.machineId || !isDaemonOwner(ws, state.machineId))
        return;
      deps.wsTunnelHub.onOpened(msg.tunnelId, state.machineId);
      return;
    }
    case "tunnel-ws-data": {
      if (state.role !== "daemon" || !state.machineId || !isDaemonOwner(ws, state.machineId))
        return;
      deps.wsTunnelHub.onData(msg.tunnelId, msg.data, msg.binary, state.machineId);
      return;
    }
    case "tunnel-ws-close": {
      if (state.role !== "daemon" || !state.machineId || !isDaemonOwner(ws, state.machineId))
        return;
      deps.wsTunnelHub.onClose(msg.tunnelId, msg.code, msg.reason, state.machineId);
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
      if (deps.discovery === false) {
        relayLog("Rejected list-machines: discovery disabled");
        sendJSON(ws, { type: "error", error: "Discovery is disabled on this relay" });
        return;
      }
      state.role = "app";
      relayLog(`App list-machines; online=${getOnlineMachines().length}`);
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
      if (deps.discovery === false) {
        relayLog("Rejected pair-request: discovery disabled");
        sendJSON(ws, {
          type: "pair-response",
          success: false,
          error: "Pairing is disabled on this relay",
        });
        return;
      }
      state.role = "app";
      relayLog(`App pair-request target=${msg.machineId || "<auto>"} device=${msg.deviceName}`);
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
      const payload = msg.payload as Record<string, unknown>;
      const payloadType = payload?.type;
      const requestType = typeof payloadType === "string" ? payloadType : undefined;
      const requestAction =
        payloadType === "goal-control" && typeof payload.action === "string"
          ? payload.action
          : undefined;
      const isUntrackedControl =
        payloadType === "abort" || (payloadType === "goal-control" && requestAction === "pause");

      if (payloadType === "init") {
        const activeTurnId = payload.activeTurnId;
        const activeTurnKind = payload.activeTurnKind;
        if (typeof activeTurnId === "string" && activeTurnId.length > 0) {
          // Rebind the still-running turn before forwarding init. The daemon keeps
          // publishing under the original turn request id via AsyncLocalStorage.
          // Crucially, rebind does not overwrite message/goal-control with init.
          if (!deps.requests.rebind(activeTurnId, ws, msg.machineId, deps.now?.())) {
            deps.requests.track(
              activeTurnId,
              ws,
              msg.machineId,
              deps.now?.(),
              activeTurnKind === "goal" ? "goal-control" : "active-turn"
            );
          }

          if (activeTurnId === msg.requestId) {
            // Compatibility with current clients that reuse the active turn id
            // as the init envelope id. Both terminal conditions must be observed.
            deps.requests.markInitPending(activeTurnId, deps.now?.());
          } else {
            deps.requests.track(msg.requestId, ws, msg.machineId, deps.now?.(), "init");
          }
        } else {
          deps.requests.track(msg.requestId, ws, msg.machineId, deps.now?.(), "init");
        }
      } else if (!isUntrackedControl) {
        deps.requests.track(
          msg.requestId,
          ws,
          msg.machineId,
          deps.now?.(),
          requestType,
          requestAction
        );
      }
      relayLog(
        `App relay-request machine=${msg.machineId} request=${msg.requestId} payload=${(msg.payload as Record<string, unknown>)?.type || "<unknown>"}`
      );
      const forwarded = forwardToDaemon(msg.machineId, msg.requestId, msg.token, msg.payload);
      if (!forwarded) {
        deps.requests.delete(msg.requestId);
        sendJSON(ws, {
          type: "relay-response",
          requestId: msg.requestId,
          payload: { type: "error", error: `Daemon ${msg.machineId} is not online.` },
        });
      } else if (payloadType === "goal-control" && requestAction === "cancel") {
        // Cancel's cleared event is correlated to this request id. The driver
        // that owned the previous goal stream exits silently after cancellation,
        // so its obsolete tracker must not survive until TTL.
        deps.requests.deleteOtherGoalStreams(ws, msg.machineId, msg.requestId);
      }
      return;
    }
  }
}
