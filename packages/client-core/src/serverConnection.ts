// ── 服务端连接(传输层,零 React 依赖) ─────────────────────────
// P6b:从 useAgent 抽出——WS/Relay 生命周期、指数退避重连、鉴权握手
// (register→auth→init / relay 免 token init)、_reqId RPC、消息分发。
// 入站流式事件即归一化 AgentEvent(server 已切换,P6b Task 3)。

import { RelayClient } from "./relayClient";
import { sealCredentialSecret, type SecureRandomBytes } from "./credentialCrypto";
import {
  AGENT_EVENT_TYPE_NAMES,
  WorkspaceProjectCatalogEntry,
  WorkspaceSessionScope,
  type AgentEventType,
  type WorkspaceSessionScopeType,
  type WorkspaceProjectCatalogEntryType,
  type WorkspaceImportSourceType,
  type GitCredentialProfileType,
  type SealedSecretEnvelopeType,
  type GitCredentialResultMsgType,
  type GitOperationResultMsgType,
  type GitWorkspaceOperationType,
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

export type GitCredentialResponse = GitCredentialResultMsgType;
export type GitOperationResponse = GitOperationResultMsgType;

export interface GitCredentialUpsertArgs {
  profile: GitCredentialProfileType;
  /** Direct WSS only. Use sealedSecret for Relay mode. */
  secret?: string;
  sealedSecret?: SealedSecretEnvelopeType;
  /** RN callers should pass expo-crypto getRandomBytes for Relay sealing. */
  randomBytes?: SecureRandomBytes;
  /** Allows callers that pre-seal to bind the envelope to the same RPC id. */
  requestId?: string;
}

export interface GitCredentialTestArgs {
  credentialProfileId: string;
  repositoryUrl: string;
  capability?: "read" | "write";
}

export interface GitWorkspaceImportArgs {
  projectId: string;
  displayName?: string;
  repositoryUrl: string;
  credentialProfileId: string;
  branch?: string;
}

export interface GitWorkspaceOperationArgs {
  projectId: string;
  operation: GitWorkspaceOperationType;
  credentialProfileId: string;
  commitMessage?: string;
}

export interface ConnectionConfig {
  getServerUrl(): string;
  isRelayMode(): boolean;
  getRelayOptions(): {
    machineId: string;
    deviceId: string;
    token?: string;
    publicKey?: string;
    keyId?: string;
  };
  getAuthToken(): string | undefined;
  getDeviceId(): string;
  buildInitPayload(): Record<string, unknown>;
  isRelayPaired(): boolean;
  /** 配对成功后由宿主持久化 token(RN: updateSettings 包装;Web: localStorage) */
  onTokenPersist?: (token: string, machineId: string) => void;
  onEncryptionKeyPersist?: (key: { publicKey: string; keyId: string }, machineId: string) => void;
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
  /** Init ack and any replay backlog have both been delivered. */
  onSessionReady?(sessionId: string): void;
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
/** Server Git subprocesses may run for 10 minutes; leave response delivery headroom. */
const REMOTE_GIT_TIMEOUT_MS = 11 * 60 * 1000;

export class ServerConnection {
  private ws: WebSocket | RelayClient | null = null;
  /** A writable socket is not usable for turns until the server acknowledges init. */
  private sessionReady = false;
  private strictTurnCorrelation = false;
  /** Explicit session switches must not rehydrate the previous session's global cursor. */
  private hydratePersistedCursor = true;
  private shouldConnect = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  /** _reqId/callId → resolver(RPC 关联:tool-exec 与 file/sync 请求) */
  private resolvers = new Map<
    string,
    { resolve: (result: unknown) => void; reject: (error: Error) => void }
  >();
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

  get isReady(): boolean {
    return this.isOpen && this.sessionReady;
  }

  get supportsTurnCorrelation(): boolean {
    return this.strictTurnCorrelation;
  }

  sendRaw(obj: Record<string, unknown>): boolean {
    if (!this.isOpen || !this.ws) return false;
    try {
      const sent = this.ws.send(JSON.stringify(obj));
      return sent !== false;
    } catch {
      return false;
    }
  }

  /** Explicit session/project switches must not reuse another stream's epoch cursor. */
  resetSessionCursor(): void {
    this.cursor = { lastSeq: 0 };
    this.gapStrikes = 0;
    this.hydratePersistedCursor = false;
  }

  connect(): void {
    this.shouldConnect = true;
    this.clearReconnect();
    if (this.isOpen) return;
    this.sessionReady = false;
    this.strictTurnCorrelation = false;

    const persisted = this.hydratePersistedCursor ? this.config.getEventCursor?.() : undefined;
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
        pinnedEncryptionKey:
          relay.publicKey && relay.keyId
            ? { publicKey: relay.publicKey, keyId: relay.keyId }
            : undefined,
        onTokenPersist: this.config.onTokenPersist,
        onEncryptionKeyPersist: this.config.onEncryptionKeyPersist,
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
          if (
            !this.sendRaw({
              type: "init",
              ...this.buildCurrentInitPayload(),
              ...this.cursorInitFields(),
            })
          ) {
            this.closeForReconnect();
          }
        } else {
          console.log("[Conn] Connected to relay but not paired yet.");
        }
      } else {
        const token = this.config.getAuthToken();
        if (token) {
          if (!this.sendInit(token)) this.closeForReconnect();
        } else {
          if (!this.sendRaw({ type: "register", deviceId: this.config.getDeviceId() })) {
            this.closeForReconnect();
          }
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
      this.sessionReady = false;
      this.activeWorkspaceScope = undefined;
      this.rejectAllResolvers("WebSocket disconnected");
      this.handlers.onDisconnected();
      // Let the host observe the capability of the connection that just went
      // away (it determines whether an in-flight turn is safe to replay).
      this.strictTurnCorrelation = false;
      if (this.shouldConnect) this.scheduleReconnect();
    };

    ws.onerror = () => {
      console.error("[Conn] WebSocket error");
      // onerror 后会触发 onclose,由 onclose 统一调度重连
    };
  }

  disconnect(): void {
    const wasOpen = this.isOpen;
    const ws = this.ws;
    this.shouldConnect = false;
    this.sessionReady = false;
    this.clearReconnect();
    if (this.cursor.epoch) this.config.persistEventCursor?.(this.cursor.epoch, this.cursor.lastSeq);
    this.activeWorkspaceScope = undefined;
    this.rejectAllResolvers("WebSocket disconnected");
    // Detach first. Browser sockets call onclose asynchronously while test and
    // alternate transports may call it synchronously; either way the stale
    // callback must not duplicate the explicit host notification below.
    this.ws = null;
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    // Clearing this.ws intentionally makes the socket's later onclose stale.
    // Notify hosts here so a manual disconnect cannot leave a green connected
    // badge or a legacy replay waiter locked forever.
    if (wasOpen) this.handlers.onDisconnected();
    this.strictTurnCorrelation = false;
  }

  private sendInit(token: string): boolean {
    return this.sendRaw({
      type: "init",
      token,
      ...this.buildCurrentInitPayload(),
      ...this.cursorInitFields(),
    });
  }

  /** A failed handshake write is transport failure: keep reconnect enabled. */
  private closeForReconnect(): void {
    this.sessionReady = false;
    try {
      this.ws?.close();
    } catch {
      /* onclose owns reconnect scheduling when the transport can report it */
    }
  }

  /** A server-invalid init response needs user action, not a reconnect loop. */
  private stopUnreadyConnection(): void {
    this.sessionReady = false;
    this.shouldConnect = false;
    this.clearReconnect();
    try {
      this.ws?.close();
    } catch {
      /* the connection remains manually recoverable through connect() */
    }
  }

  private rejectAllResolvers(message: string): void {
    const resolvers = [...this.resolvers.values()];
    this.resolvers.clear();
    for (const resolver of resolvers) resolver.reject(new Error(message));
  }

  /** Never emit the deprecated plaintext credential array from current clients. */
  private buildCurrentInitPayload(): Record<string, unknown> {
    const { gitCredentials: _legacyCredentials, ...payload } = this.config.buildInitPayload();
    return payload;
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
        if (!this.sendInit(data.token)) this.closeForReconnect();
        return;
      }
      case data.type === "session": {
        // A legacy ack has no replay phase, so a cold client can adopt currentSeq.
        // New servers mark backlogPending and then deliver seq frames before
        // session-ready; bind only the epoch here or those replay frames would be
        // mistaken for duplicates and the queued turn's done could be lost.
        if (typeof data.eventEpoch === "string" && !this.cursor.epoch) {
          this.cursor = {
            epoch: data.eventEpoch,
            lastSeq: data.backlogPending === true ? 0 : (data.currentSeq ?? 0),
          };
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
            this.sessionReady = false;
            this.handlers.onAgentEvent({
              type: "error",
              message: "Server returned an invalid workspace scope.",
            });
            this.stopUnreadyConnection();
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
            this.stopUnreadyConnection();
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
              this.sessionReady = false;
              this.stopUnreadyConnection();
              return;
            }
            workspaceCatalog.push(parsedEntry.data);
          }
        }
        this.activeWorkspaceScope = workspaceScope;
        this.strictTurnCorrelation = data.turnCorrelationVersion === 1;
        this.sessionReady = data.backlogPending !== true;
        this.handlers.onSession(data.sessionId, workspaceScope, workspaceCatalog);
        if (this.sessionReady) this.handlers.onSessionReady?.(data.sessionId);
        return;
      }
      case data.type === "session-ready": {
        if (typeof data.eventEpoch === "string") {
          if (!this.cursor.epoch) this.cursor.epoch = data.eventEpoch;
          if (this.cursor.epoch === data.eventEpoch && typeof data.currentSeq === "number") {
            this.cursor.lastSeq = Math.max(this.cursor.lastSeq, data.currentSeq);
          }
        }
        this.sessionReady = true;
        this.handlers.onSessionReady?.(data.sessionId);
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
        data.type === "workspace-legacy-cleaned" ||
        data.type === "git-credential-result" ||
        data.type === "git-operation-result": {
        const resolver = data._reqId && this.resolvers.get(data._reqId);
        if (resolver) {
          resolver.resolve(data);
          this.resolvers.delete(data._reqId);
        }
        return;
      }
      // tool-result:pending execTool(geek RPC)优先按 callId 消化;否则是流式事件
      case data.type === "tool-result": {
        const resolver = data.callId && this.resolvers.get(data.callId);
        if (resolver) {
          resolver.resolve(data.result);
          this.resolvers.delete(data.callId);
          return;
        }
        if (!this.admitSeq(data)) return;
        this.handlers.onAgentEvent(data as AgentEventType);
        return;
      }
      case data.type === "error": {
        const correlationId = data._reqId ?? data.callId ?? data.turnId;
        const resolver = correlationId && this.resolvers.get(correlationId);
        if (resolver) {
          resolver.reject(new Error(String(data.error ?? data.message ?? "Request failed")));
          this.resolvers.delete(correlationId);
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
          this.sessionReady = false;
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
        // A Relay socket can be open while the target daemon is unavailable. Closing it
        // here re-runs init through the normal reconnect path instead of leaving the App
        // permanently transport-open but session-unready.
        const daemonOffline =
          typeof data.error === "string" && data.error.includes("is not online");
        if (daemonOffline) {
          this.sessionReady = false;
          try {
            this.ws?.close();
          } catch {
            /* onclose owns reconnect scheduling */
          }
        }
        // 其余控制错误作为归一化 error 事件交给上层(字段名适配:出站 error 用 {error})
        this.handlers.onAgentEvent({
          type: "error",
          message: String(data.error ?? "unknown"),
          code: "control-error",
          ...(typeof data.turnId === "string" ? { turnId: data.turnId } : {}),
        });
        if (!daemonOffline && !this.sessionReady) this.stopUnreadyConnection();
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
      this.resolvers.set(key, {
        resolve: resolve as (r: unknown) => void,
        reject,
      });
      setTimeout(() => {
        if (this.resolvers.has(key)) {
          this.resolvers.delete(key);
          reject(new Error(`${what} timed out`));
        }
      }, timeoutMs);
      if (!this.sendRaw(payload)) {
        this.resolvers.delete(key);
        reject(new Error(`WebSocket send failed (${what})`));
      }
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

  upsertGitCredential(args: GitCredentialUpsertArgs): Promise<GitCredentialResponse> {
    const reqId =
      args.requestId ??
      args.sealedSecret?.requestId ??
      `cred_upsert_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    let secret = args.secret;
    let sealedSecret = args.sealedSecret;
    if (this.config.isRelayMode() && secret) {
      if (sealedSecret)
        return Promise.reject(new Error("Provide either secret or sealedSecret, not both"));
      const relay = this.config.getRelayOptions();
      if (!relay.publicKey || !relay.keyId) {
        return Promise.reject(
          new Error(
            "Paired daemon has no pinned encryption key; pair again before installing credentials"
          )
        );
      }
      sealedSecret = sealCredentialSecret(
        { secret, profile: args.profile, requestId: reqId },
        { publicKey: relay.publicKey, keyId: relay.keyId },
        { randomBytes: args.randomBytes }
      );
      secret = undefined;
    }
    if (
      sealedSecret &&
      (sealedSecret.requestId !== reqId ||
        sealedSecret.profileId !== args.profile.id ||
        sealedSecret.origin !== args.profile.origin)
    ) {
      return Promise.reject(
        new Error("Encrypted credential binding does not match the upsert request")
      );
    }
    return this.request(
      {
        type: "git-credential-upsert",
        _reqId: reqId,
        profile: args.profile,
        ...(secret ? { secret } : {}),
        ...(sealedSecret ? { sealedSecret } : {}),
      },
      reqId,
      15_000,
      "Git credential upsert"
    );
  }

  testGitCredential(args: GitCredentialTestArgs): Promise<GitCredentialResponse> {
    const reqId = `cred_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return this.request(
      { type: "git-credential-test", _reqId: reqId, ...args },
      reqId,
      30_000,
      "Git credential test"
    );
  }

  deleteGitCredential(credentialProfileId: string): Promise<GitCredentialResponse> {
    const reqId = `cred_delete_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return this.request(
      { type: "git-credential-delete", credentialProfileId, _reqId: reqId },
      reqId,
      15_000,
      "Git credential delete"
    );
  }

  importGitWorkspace(args: GitWorkspaceImportArgs): Promise<LinkedWorkspaceImportResponse> {
    const reqId = `git_import_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return this.request(
      { type: "workspace-import-git", _reqId: reqId, ...args },
      reqId,
      REMOTE_GIT_TIMEOUT_MS,
      "Git workspace import"
    );
  }

  runGitWorkspaceOperation(args: GitWorkspaceOperationArgs): Promise<GitOperationResponse> {
    const reqId = `git_op_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return this.request(
      { type: "git-workspace-operation", _reqId: reqId, ...args },
      reqId,
      args.operation === "status" ? 15_000 : REMOTE_GIT_TIMEOUT_MS,
      `Git workspace ${args.operation}`
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
