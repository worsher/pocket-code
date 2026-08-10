// ── 服务端连接(传输层,零 React 依赖) ─────────────────────────
// P6b:从 useAgent 抽出——WS/Relay 生命周期、指数退避重连、鉴权握手
// (register→auth→init / relay 免 token init)、_reqId RPC、消息分发。
// 入站流式事件即归一化 AgentEvent(server 已切换,P6b Task 3)。

import { RelayClient } from "./relayClient";
import {
  AGENT_EVENT_TYPE_NAMES,
  WorkspaceProjectCatalogEntry,
  WorkspaceSessionScope,
  type AgentEventType,
  type WorkspaceSessionScopeType,
  type WorkspaceProjectCatalogEntryType,
  type WorkspaceImportSourceType,
} from "@pocket-code/wire";

export interface LinkedWorkspaceImportResponse {
  type: "workspace-import-result";
  status: "imported" | "confirmation-required" | "blocked" | "error";
  existingProjectId?: string;
  project?: WorkspaceProjectCatalogEntryType;
  importSource?: WorkspaceImportSourceType;
  error?: string;
  _reqId: string;
}

export interface WorkspaceWriterReleaseResponse {
  type: "workspace-writer-released";
  projectId: string;
  replicaId: string;
  success: boolean;
  workspaceGeneration?: number;
  error?: string;
  _reqId: string;
}

export interface WorkspaceSourceStatusResponse {
  type: "workspace-source-status";
  projectId: string;
  state: "available" | "permission-lost" | "moved" | "missing" | "replaced" | "unsupported";
  checkedAt: number;
  canonicalLocator?: string;
  resolvedLocator?: string;
  stableFileId?: string;
  error?: string;
  _reqId: string;
}

export interface WorkspaceLegacyCleanupResponse {
  type: "workspace-legacy-cleaned";
  projectId: string;
  legacyProjectId: string;
  success: boolean;
  cleaned: boolean;
  error?: string;
  _reqId: string;
}

export interface ConnectionConfig {
  getServerUrl(): string;
  isRelayMode(): boolean;
  getRelayOptions(): { machineId: string; deviceId: string; token?: string };
  getAuthToken(): string | undefined;
  getDeviceId(): string;
  buildInitPayload(): Record<string, unknown>;
  isRelayPaired(): boolean;
  /** 配对成功后由宿主持久化 token(RN: updateSettings 包装;Web: localStorage) */
  onTokenPersist?: (token: string, machineId: string) => void;
  /** P14 D-P14-4 预留:宿主持久化事件游标;缺省内存态(冷启动走全量 loadSession)。 */
  getEventCursor?: () => { epoch: string; lastSeq: number } | undefined;
  persistEventCursor?: (epoch: string, lastSeq: number) => void;
}

export interface ConnectionHandlers {
  onAgentEvent(ev: AgentEventType): void;
  onAuth(token: string, userId: string): void;
  onSession(
    sessionId: string,
    workspaceScope?: WorkspaceSessionScopeType,
    workspaceCatalog?: WorkspaceProjectCatalogEntryType[]
  ): void;
  onConnected(): void;
  onDisconnected(): void;
  onAuthError(message: string): void;
  onFileChanged(
    path: string,
    changeType: "created" | "modified" | "deleted",
    workspaceScope?: WorkspaceSessionScopeType
  ): void;
  /** P14:server 指示全量重建(epoch 变化/缓冲覆盖不足/连续缺口)。宿主应走 loadSession。 */
  onResyncRequired?(reason: string): void;
  onWorkspaceEventDropped?(reason: "invalid-or-stale-scope"): void;
}

/** 归一化流式事件类型集合(据此路由到 onAgentEvent)。
 *  单一真相源:wire 联合派生,新增事件自动覆盖,勿回退为手写清单。 */
const AGENT_EVENT_TYPES = new Set<string>(AGENT_EVENT_TYPE_NAMES);

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;

export class ServerConnection {
  private ws: WebSocket | RelayClient | null = null;
  private shouldConnect = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  /** _reqId/callId → resolver(RPC 关联:tool-exec 与 file/sync 请求) */
  private resolvers = new Map<string, (result: unknown) => void>();
  /** P14:事件流游标(epoch 缺省 = 从未收过带序事件,init 不请求补发) */
  private cursor: { epoch?: string; lastSeq: number } = { lastSeq: 0 };
  /** 连续缺口计数:第一次断开重连补发,第二次转 resync(spec §5.2) */
  private gapStrikes = 0;
  /** Latest server-authoritative scope. Undefined keeps v1 servers compatible. */
  private activeWorkspaceScope?: WorkspaceSessionScopeType;

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

    const persisted = this.config.getEventCursor?.();
    if (persisted && !this.cursor.epoch)
      this.cursor = { epoch: persisted.epoch, lastSeq: persisted.lastSeq };

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
        onTokenPersist: this.config.onTokenPersist,
      });
      ws.connect();
    } else {
      ws = new WebSocket(url);
    }
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      console.log("[Conn] Connected");
      this.reconnectAttempt = 0;
      this.handlers.onConnected();

      if (this.config.isRelayMode()) {
        // relay 模式:daemon 侧 preAuth,已配对则直接 init(不带 token)
        if (this.config.isRelayPaired()) {
          this.sendRaw({
            type: "init",
            ...this.config.buildInitPayload(),
            ...this.cursorInitFields(),
          });
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
      if (this.ws !== ws) return;
      const data =
        typeof event.data === "string" ? JSON.parse(event.data) : JSON.parse(event.data.toString());
      this.dispatch(data);
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      console.log("[Conn] Closed");
      this.activeWorkspaceScope = undefined;
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
    if (this.cursor.epoch) this.config.persistEventCursor?.(this.cursor.epoch, this.cursor.lastSeq);
    this.activeWorkspaceScope = undefined;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  private sendInit(token: string): void {
    this.sendRaw({
      type: "init",
      token,
      ...this.config.buildInitPayload(),
      ...this.cursorInitFields(),
    });
  }

  /** init 携带的补发协商字段(仅当有 epoch,即此前收过带序事件)。 */
  private cursorInitFields(): Record<string, unknown> {
    return this.cursor.epoch ? { lastSeq: this.cursor.lastSeq, eventEpoch: this.cursor.epoch } : {};
  }

  /**
   * P14 带 seq 事件守门:true = 放行到 onAgentEvent。
   * 无 seq(geek/旧端)原样放行,游标不动;重复丢弃(C14-3);缺口第一次断开重连
   * (重连 init 带 lastSeq 走补发),连续第二次转 resync 并采纳现值。
   */
  private admitSeq(data: { seq?: unknown; type?: string }): boolean {
    const seq = data.seq;
    if (typeof seq !== "number") return true;
    if (seq <= this.cursor.lastSeq) return false;
    if (seq > this.cursor.lastSeq + 1 && this.cursor.lastSeq > 0) {
      this.gapStrikes++;
      if (this.gapStrikes >= 2) {
        this.gapStrikes = 0;
        this.cursor.lastSeq = seq;
        this.handlers.onResyncRequired?.("gap");
        return true;
      }
      try {
        this.ws?.close();
      } catch {
        /* onclose 调度重连 */
      }
      return false;
    }
    this.cursor.lastSeq = seq;
    this.gapStrikes = 0;
    if ((data.type === "done" || data.type === "error") && this.cursor.epoch) {
      this.config.persistEventCursor?.(this.cursor.epoch, seq);
    }
    return true;
  }

  private admitWorkspaceEvent(data: { workspaceScope?: unknown }): boolean {
    if (data.workspaceScope === undefined) return true;
    const parsed = WorkspaceSessionScope.safeParse(data.workspaceScope);
    const expected = this.activeWorkspaceScope;
    if (!parsed.success || !expected) return false;
    const actual = parsed.data;
    return (
      actual.projectId === expected.projectId &&
      actual.replicaId === expected.replicaId &&
      actual.sessionId === expected.sessionId &&
      actual.workspaceGeneration === expected.workspaceGeneration &&
      actual.authorityId === expected.authorityId
    );
  }

  private dispatch(data: any): void {
    switch (true) {
      case data.type === "auth": {
        this.handlers.onAuth(data.token, data.userId);
        this.sendInit(data.token);
        return;
      }
      case data.type === "session": {
        // P14 冷启动:采纳 server 游标(此前事件不可得,交给宿主的常规历史加载);
        // 已有 epoch 且不符时不自行猜——等 server 的 resync-required 决定。
        if (typeof data.eventEpoch === "string" && !this.cursor.epoch) {
          this.cursor = { epoch: data.eventEpoch, lastSeq: data.currentSeq ?? 0 };
        }
        let workspaceScope: WorkspaceSessionScopeType | undefined;
        let workspaceCatalog: WorkspaceProjectCatalogEntryType[] | undefined;
        if (data.workspaceScope !== undefined) {
          const parsedScope = WorkspaceSessionScope.safeParse(data.workspaceScope);
          if (
            !parsedScope.success ||
            parsedScope.data.sessionId !== data.sessionId ||
            parsedScope.data.projectId !== data.projectId
          ) {
            this.activeWorkspaceScope = undefined;
            this.handlers.onAgentEvent({
              type: "error",
              message: "Server returned an invalid workspace scope.",
            });
            return;
          }
          workspaceScope = parsedScope.data;
        }
        if (data.workspaceCatalog !== undefined) {
          if (!Array.isArray(data.workspaceCatalog)) {
            this.handlers.onAgentEvent({
              type: "error",
              message: "Server returned an invalid workspace catalog.",
            });
            return;
          }
          workspaceCatalog = [];
          for (const value of data.workspaceCatalog) {
            const parsedEntry = WorkspaceProjectCatalogEntry.safeParse(value);
            if (!parsedEntry.success) {
              this.handlers.onAgentEvent({
                type: "error",
                message: "Server returned an invalid workspace catalog.",
              });
              return;
            }
            workspaceCatalog.push(parsedEntry.data);
          }
        }
        this.activeWorkspaceScope = workspaceScope;
        this.handlers.onSession(data.sessionId, workspaceScope, workspaceCatalog);
        return;
      }
      case data.type === "resync-required": {
        this.cursor = { epoch: data.eventEpoch, lastSeq: data.currentSeq ?? 0 };
        this.gapStrikes = 0;
        this.handlers.onResyncRequired?.(String(data.reason ?? "unknown"));
        return;
      }
      // RPC 响应:_reqId 关联(file-list/file-content/sync-manifest/sync-file-content)
      case data.type === "file-list" ||
        data.type === "file-content" ||
        data.type === "sync-manifest" ||
        data.type === "sync-file-content" ||
        data.type === "workspace-import-result" ||
        data.type === "workspace-writer-released" ||
        data.type === "workspace-source-status" ||
        data.type === "workspace-legacy-cleaned": {
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
        if (!this.admitSeq(data)) return;
        this.handlers.onAgentEvent(data as AgentEventType);
        return;
      }
      case data.type === "error": {
        const resolver = data._reqId && this.resolvers.get(data._reqId);
        if (resolver) {
          resolver(data);
          this.resolvers.delete(data._reqId);
          return;
        }
        // D-P14-6 分流:AgentEvent 形态({message})原样进事件流,不再被
        // 控制错误路径改写成 "unknown";控制错误({error})走原逻辑。
        if (typeof data.message === "string") {
          if (!this.admitSeq(data)) return;
          this.handlers.onAgentEvent(data as AgentEventType);
          return;
        }
        // 设备 token 被 daemon 拒绝:死 token 重试无意义,停止重连并提示重新配对
        if (typeof data.error === "string" && data.error.includes("Unauthorized")) {
          this.shouldConnect = false;
          this.clearReconnect();
          this.handlers.onAuthError("设备未授权或配对已失效,请在设置中重新配对");
          try {
            this.ws?.close();
          } catch {
            /* ignore */
          }
          return;
        }
        // 其余控制错误作为归一化 error 事件交给上层(字段名适配:出站 error 用 {error})
        this.handlers.onAgentEvent({ type: "error", message: String(data.error ?? "unknown") });
        return;
      }
      case AGENT_EVENT_TYPES.has(data.type): {
        // Scope check must precede seq admission: a stale replica event must
        // never advance the active session's event cursor.
        if (data.type === "file-changed" && !this.admitWorkspaceEvent(data)) {
          this.handlers.onWorkspaceEventDropped?.("invalid-or-stale-scope");
          return;
        }
        if (!this.admitSeq(data)) return;
        if (data.type === "file-changed") {
          this.handlers.onFileChanged(data.path, data.changeType, data.workspaceScope);
        }
        this.handlers.onAgentEvent(data as AgentEventType);
        return;
      }
      default:
        return; // machines-list/pair-response 等由设置页的独立连接处理
    }
  }

  // ── RPC helpers(_reqId 请求-响应 + 超时) ──────────────
  private request<T>(
    payload: Record<string, unknown>,
    key: string,
    timeoutMs: number,
    what: string
  ): Promise<T> {
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
    return this.request(
      { type: "tool-exec", callId, toolName, args },
      callId,
      30000,
      `Tool ${toolName}`
    );
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
    return this.request(
      { type: "sync-pull", sinceCommit, _reqId: reqId },
      reqId,
      30000,
      "Sync pull"
    );
  }

  releaseWorkspaceWriter(args: {
    projectId: string;
    replicaId: string;
    workspaceGeneration: number;
  }): Promise<WorkspaceWriterReleaseResponse> {
    const reqId = `wr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return this.request(
      { type: "workspace-writer-release", _reqId: reqId, ...args },
      reqId,
      10_000,
      "Workspace writer release"
    );
  }

  bindLinkedWorkspace(args: {
    projectId: string;
    displayName?: string;
    path: string;
    allowWeakDuplicate?: boolean;
  }): Promise<LinkedWorkspaceImportResponse> {
    const reqId = `wi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return this.request(
      {
        type: "workspace-bind-linked",
        _reqId: reqId,
        ...args,
      },
      reqId,
      30_000,
      "Linked workspace import"
    );
  }

  inspectWorkspaceSource(projectId: string): Promise<WorkspaceSourceStatusResponse> {
    const reqId = `source_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return this.request(
      { type: "workspace-source-inspect", projectId, _reqId: reqId },
      reqId,
      10_000,
      "Workspace source inspection"
    );
  }

  cleanupLegacyWorkspace(
    projectId: string,
    legacyProjectId: string
  ): Promise<WorkspaceLegacyCleanupResponse> {
    const reqId = `legacy_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return this.request(
      { type: "workspace-legacy-cleanup", projectId, legacyProjectId, _reqId: reqId },
      reqId,
      30_000,
      "Legacy workspace cleanup"
    );
  }

  syncFile(commit: string, path: string): Promise<any> {
    const reqId = `sf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return this.request(
      { type: "sync-file", commit, path, _reqId: reqId },
      reqId,
      30000,
      "Sync file"
    );
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
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt),
      RECONNECT_MAX_MS
    );
    this.reconnectAttempt += 1;
    console.log(`[Conn] Reconnecting in ${(delay / 1000).toFixed(1)}s`);
    this.reconnectTimer = setTimeout(() => {
      if (this.shouldConnect) this.connect();
    }, delay);
  }
}
