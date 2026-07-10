// 【冻结副本】已被 @pocket-code/client-core 收编为正典(P10)。此副本冻结:
// 只修 bug 且必须双侧同步;P11 RN 切换消费 client-core 时删除本文件。
// ── 服务端连接(传输层,零 React 依赖) ─────────────────────────
// P6b:从 useAgent 抽出——WS/Relay 生命周期、指数退避重连、鉴权握手
// (register→auth→init / relay 免 token init)、_reqId RPC、消息分发。
// 入站流式事件即归一化 AgentEvent(server 已切换,P6b Task 3)。

import { RelayClient } from "./relayClient";
import type { AgentEventType } from "@pocket-code/wire";

export interface ConnectionConfig {
  getServerUrl(): string;
  isRelayMode(): boolean;
  getRelayOptions(): { machineId: string; deviceId: string; token?: string };
  getAuthToken(): string | undefined;
  getDeviceId(): string;
  buildInitPayload(): Record<string, unknown>;
  isRelayPaired(): boolean;
}

export interface ConnectionHandlers {
  onAgentEvent(ev: AgentEventType): void;
  onAuth(token: string, userId: string): void;
  onSession(sessionId: string): void;
  onConnected(): void;
  onDisconnected(): void;
  onAuthError(message: string): void;
  onFileChanged(path: string, changeType: "created" | "modified" | "deleted"): void;
}

/** 归一化流式事件类型集合(据此路由到 onAgentEvent) */
const AGENT_EVENT_TYPES = new Set([
  "text-delta", "reasoning-delta", "tool-call", "tool-result", "file-changed",
  "command-output", "process-started", "process-exited", "preview-available",
  "model-selected", "usage", "done", "error",
]);

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;

export class ServerConnection {
  private ws: WebSocket | RelayClient | null = null;
  private shouldConnect = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  /** _reqId/callId → resolver(RPC 关联:tool-exec 与 file/sync 请求) */
  private resolvers = new Map<string, (result: unknown) => void>();

  constructor(
    private config: ConnectionConfig,
    private handlers: ConnectionHandlers
  ) {}

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  sendRaw(obj: Record<string, unknown>): boolean {
    if (!this.isOpen || !this.ws) return false;
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  connect(): void {
    this.shouldConnect = true;
    this.clearReconnect();
    if (this.isOpen) return;

    const url = this.config.getServerUrl();
    console.log("[Conn] Connecting to:", url, "relay:", this.config.isRelayMode());

    let ws: WebSocket | RelayClient;
    if (this.config.isRelayMode()) {
      const relay = this.config.getRelayOptions();
      ws = new RelayClient({
        relayUrl: url,
        machineId: relay.machineId,
        deviceId: relay.deviceId,
        deviceName: "Pocket Code App",
        token: relay.token,
      });
      ws.connect();
    } else {
      ws = new WebSocket(url);
    }
    this.ws = ws;

    ws.onopen = () => {
      console.log("[Conn] Connected");
      this.reconnectAttempt = 0;
      this.handlers.onConnected();

      if (this.config.isRelayMode()) {
        // relay 模式:daemon 侧 preAuth,已配对则直接 init(不带 token)
        if (this.config.isRelayPaired()) {
          this.sendRaw({ type: "init", ...this.config.buildInitPayload() });
        } else {
          console.log("[Conn] Connected to relay but not paired yet.");
        }
      } else {
        const token = this.config.getAuthToken();
        if (token) {
          this.sendInit(token);
        } else {
          this.sendRaw({ type: "register", deviceId: this.config.getDeviceId() });
        }
      }
    };

    ws.onmessage = (event: MessageEvent<any> | { data: string }) => {
      const data =
        typeof event.data === "string" ? JSON.parse(event.data) : JSON.parse(event.data.toString());
      this.dispatch(data);
    };

    ws.onclose = () => {
      console.log("[Conn] Closed");
      this.handlers.onDisconnected();
      if (this.shouldConnect) this.scheduleReconnect();
    };

    ws.onerror = () => {
      console.error("[Conn] WebSocket error");
      // onerror 后会触发 onclose,由 onclose 统一调度重连
    };
  }

  disconnect(): void {
    this.shouldConnect = false;
    this.clearReconnect();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  private sendInit(token: string): void {
    this.sendRaw({ type: "init", token, ...this.config.buildInitPayload() });
  }

  private dispatch(data: any): void {
    switch (true) {
      case data.type === "auth": {
        this.handlers.onAuth(data.token, data.userId);
        this.sendInit(data.token);
        return;
      }
      case data.type === "session": {
        this.handlers.onSession(data.sessionId);
        return;
      }
      // RPC 响应:_reqId 关联(file-list/file-content/sync-manifest/sync-file-content)
      case data.type === "file-list" || data.type === "file-content" ||
           data.type === "sync-manifest" || data.type === "sync-file-content": {
        const resolver = data._reqId && this.resolvers.get(data._reqId);
        if (resolver) {
          resolver(data);
          this.resolvers.delete(data._reqId);
        }
        return;
      }
      // tool-result:pending execTool(geek RPC)优先按 callId 消化;否则是流式事件
      case data.type === "tool-result": {
        const resolver = data.callId && this.resolvers.get(data.callId);
        if (resolver) {
          resolver(data.result);
          this.resolvers.delete(data.callId);
          return;
        }
        this.handlers.onAgentEvent(data as AgentEventType);
        return;
      }
      case data.type === "error": {
        // 设备 token 被 daemon 拒绝:死 token 重试无意义,停止重连并提示重新配对
        if (typeof data.error === "string" && data.error.includes("Unauthorized")) {
          this.shouldConnect = false;
          this.clearReconnect();
          this.handlers.onAuthError("设备未授权或配对已失效,请在设置中重新配对");
          try { this.ws?.close(); } catch { /* ignore */ }
          return;
        }
        // 其余错误作为归一化 error 事件交给上层(字段名适配:出站 error 用 {error})
        this.handlers.onAgentEvent({ type: "error", message: String(data.error ?? "unknown") });
        return;
      }
      case AGENT_EVENT_TYPES.has(data.type): {
        if (data.type === "file-changed") {
          this.handlers.onFileChanged(data.path, data.changeType);
        }
        this.handlers.onAgentEvent(data as AgentEventType);
        return;
      }
      default:
        return; // machines-list/pair-response 等由设置页的独立连接处理
    }
  }

  // ── RPC helpers(_reqId 请求-响应 + 超时) ──────────────
  private request<T>(payload: Record<string, unknown>, key: string, timeoutMs: number, what: string): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.isOpen) {
        reject(new Error(`WebSocket not connected (${what})`));
        return;
      }
      this.resolvers.set(key, resolve as (r: unknown) => void);
      setTimeout(() => {
        if (this.resolvers.has(key)) {
          this.resolvers.delete(key);
          reject(new Error(`${what} timed out`));
        }
      }, timeoutMs);
      this.sendRaw(payload);
    });
  }

  execTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const callId = `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return this.request({ type: "tool-exec", callId, toolName, args }, callId, 30000, `Tool ${toolName}`);
  }

  listFiles(path: string = "."): Promise<any> {
    const reqId = `fr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return this.request({ type: "list-files", path, _reqId: reqId }, reqId, 10000, "File list");
  }

  readFile(path: string): Promise<any> {
    const reqId = `fr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return this.request({ type: "read-file", path, _reqId: reqId }, reqId, 10000, "File read");
  }

  syncPull(sinceCommit?: string): Promise<any> {
    const reqId = `sp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return this.request({ type: "sync-pull", sinceCommit, _reqId: reqId }, reqId, 30000, "Sync pull");
  }

  syncFile(commit: string, path: string): Promise<any> {
    const reqId = `sf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return this.request({ type: "sync-file", commit, path, _reqId: reqId }, reqId, 30000, "Sync file");
  }

  // ── 重连(指数退避) ────────────────────────────────────
  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldConnect) return;
    this.clearReconnect();
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt), RECONNECT_MAX_MS);
    this.reconnectAttempt += 1;
    console.log(`[Conn] Reconnecting in ${(delay / 1000).toFixed(1)}s`);
    this.reconnectTimer = setTimeout(() => {
      if (this.shouldConnect) this.connect();
    }, delay);
  }
}
