// ── Request Tracker ───────────────────────────────────────
// 维护 requestId → App socket 的映射,带每条记录的时间戳与 TTL。
// 修复原 requestMap 的内存泄漏:原清理只删"已关闭 socket"的条目,
// socket 开着但请求悬挂(daemon 慢/丢响应)时条目会无限累积。

// ws.readyState 的 OPEN 常量(避免在此 import 'ws' 仅为一个常量)。
const WS_OPEN = 1;

interface MinimalSocket {
  readyState: number;
}

interface Entry<S> {
  ws: S;
  /** 该请求发往的目标 daemon(P6a 身份绑定:回帧必须来自它) */
  machineId: string;
  ts: number;
  /** Business payload type, used to distinguish one-shot turns from long streams. */
  requestType?: string;
  /** goal-control action, when the request type alone is not specific enough. */
  requestAction?: string;
  /** A reconnect init shares this id with an existing turn on older clients. */
  initPending?: boolean;
  /** The original turn ended while its same-id reconnect init was still replaying. */
  terminalSeen?: boolean;
  /** A correlated terminal error must still forward its following done frame. */
  deleteAfterDone?: boolean;
}

export interface StaleRequest<S> {
  requestId: string;
  ws: S;
  machineId: string;
  requestType?: string;
  updatedAt: number;
  reason: "socket-closed" | "timeout";
}

export class RequestTracker<S extends MinimalSocket = MinimalSocket> {
  private map = new Map<string, Entry<S>>();

  /** @param ttlMs 悬挂请求的最大存活时间(默认 30 分钟)。 */
  constructor(private readonly ttlMs: number = 30 * 60 * 1000) {}

  /** 记录一条请求(requestId → 发起的 App socket + 目标 daemon)。 */
  track(
    requestId: string,
    ws: S,
    machineId: string,
    now: number = Date.now(),
    requestType?: string,
    requestAction?: string
  ): void {
    const existing = this.map.get(requestId);
    if (existing && existing.machineId === machineId) {
      existing.ws = ws;
      existing.ts = now;
      existing.requestType = requestType ?? existing.requestType;
      existing.requestAction = requestAction ?? existing.requestAction;
      return;
    }
    this.map.set(requestId, { ws, machineId, ts: now, requestType, requestAction });
  }

  /** 取某请求的 App socket 与归属 daemon。 */
  get(requestId: string):
    | {
        ws: S;
        machineId: string;
        requestType?: string;
        requestAction?: string;
        initPending?: boolean;
        terminalSeen?: boolean;
        deleteAfterDone?: boolean;
      }
    | undefined {
    const e = this.map.get(requestId);
    return e
      ? {
          ws: e.ws,
          machineId: e.machineId,
          requestType: e.requestType,
          requestAction: e.requestAction,
          initPending: e.initPending,
          terminalSeen: e.terminalSeen,
          deleteAfterDone: e.deleteAfterDone,
        }
      : undefined;
  }

  /** Rebind an existing request without changing its original request type. */
  rebind(requestId: string, ws: S, machineId: string, now: number = Date.now()): boolean {
    const entry = this.map.get(requestId);
    if (!entry || entry.machineId !== machineId) return false;
    entry.ws = ws;
    entry.ts = now;
    return true;
  }

  setRequestType(requestId: string, requestType: string, now: number = Date.now()): void {
    const entry = this.map.get(requestId);
    if (!entry) return;
    entry.requestType = requestType;
    entry.ts = now;
  }

  /** Mark that session-ready must arrive before a same-id turn entry can be removed. */
  markInitPending(requestId: string, now: number = Date.now()): void {
    const entry = this.map.get(requestId);
    if (!entry) return;
    entry.initPending = true;
    entry.ts = now;
  }

  /**
   * Complete reconnect init. A dedicated init request ends immediately; an
   * older same-id init only ends the init half of the original turn entry.
   */
  completeInit(requestId: string, now: number = Date.now()): void {
    const entry = this.map.get(requestId);
    if (!entry) return;
    if (entry.requestType === "init") {
      this.map.delete(requestId);
      return;
    }
    entry.initPending = false;
    if (entry.terminalSeen) {
      this.map.delete(requestId);
      return;
    }
    entry.ts = now;
  }

  /** Complete a request, retaining it only while a same-id init still needs session-ready. */
  completeRequest(requestId: string, now: number = Date.now()): void {
    const entry = this.map.get(requestId);
    if (!entry) return;
    if (entry.initPending) {
      entry.terminalSeen = true;
      entry.ts = now;
      return;
    }
    this.map.delete(requestId);
  }

  markDeleteAfterDone(requestId: string, now: number = Date.now()): void {
    const entry = this.map.get(requestId);
    if (!entry) return;
    entry.deleteAfterDone = true;
    entry.ts = now;
  }

  /** Cancel replaces the one active goal stream for this App/machine connection. */
  deleteOtherGoalStreams(ws: S, machineId: string, exceptRequestId: string): void {
    for (const [requestId, entry] of this.map) {
      if (
        requestId !== exceptRequestId &&
        entry.ws === ws &&
        entry.machineId === machineId &&
        (entry.requestType === "goal-create" ||
          (entry.requestType === "goal-control" && entry.requestAction === "resume"))
      ) {
        this.map.delete(requestId);
      }
    }
  }

  /** Refresh an active stream so long-running agent turns are not evicted mid-output. */
  touch(requestId: string, now: number = Date.now()): void {
    const entry = this.map.get(requestId);
    if (entry) entry.ts = now;
  }

  /** 删除某请求(收到 final 响应或 stream done 时)。 */
  delete(requestId: string): void {
    this.map.delete(requestId);
  }

  /** 删除某 socket 的所有请求(socket 关闭时)。 */
  deleteBySocket(ws: S): void {
    for (const [id, e] of this.map) {
      if (e.ws === ws) this.map.delete(id);
    }
  }

  /** Remove and return every pending request owned by one daemon machine. */
  drainByMachine(machineId: string): Array<{
    requestId: string;
    ws: S;
    requestType?: string;
  }> {
    const drained: Array<{ requestId: string; ws: S; requestType?: string }> = [];
    for (const [requestId, entry] of this.map) {
      if (entry.machineId !== machineId) continue;
      drained.push({ requestId, ws: entry.ws, requestType: entry.requestType });
      this.map.delete(requestId);
    }
    return drained;
  }

  /**
   * 枚举已关闭 socket 或超过 TTL 的悬挂请求，但不直接删除。
   * 调用方可先向仍在线的 App 发 correlated timeout，再通过 deleteIfMatch
   * 删除本次观察到的旧版本，避免一次静默清理吞掉请求结果。
   */
  findStale(
    now: number = Date.now(),
    isOpen: (ws: S) => boolean = (ws) => ws.readyState === WS_OPEN
  ): StaleRequest<S>[] {
    const stale: StaleRequest<S>[] = [];
    for (const [requestId, entry] of this.map) {
      const socketOpen = isOpen(entry.ws);
      if (socketOpen && now - entry.ts <= this.ttlMs) continue;
      stale.push({
        requestId,
        ws: entry.ws,
        machineId: entry.machineId,
        requestType: entry.requestType,
        updatedAt: entry.ts,
        reason: socketOpen ? "timeout" : "socket-closed",
      });
    }
    return stale;
  }

  /** 删除仍与 stale 快照一致的条目；若期间已 rebind/touch，则保留新版本。 */
  deleteIfMatch(stale: StaleRequest<S>): boolean {
    const current = this.map.get(stale.requestId);
    if (
      !current ||
      current.ws !== stale.ws ||
      current.machineId !== stale.machineId ||
      current.ts !== stale.updatedAt
    ) {
      return false;
    }
    this.map.delete(stale.requestId);
    return true;
  }

  get size(): number {
    return this.map.size;
  }
}
