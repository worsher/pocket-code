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
  ts: number;
}

export class RequestTracker<S extends MinimalSocket = MinimalSocket> {
  private map = new Map<string, Entry<S>>();

  /** @param ttlMs 悬挂请求的最大存活时间(默认 2 分钟)。 */
  constructor(private readonly ttlMs: number = 2 * 60 * 1000) {}

  /** 记录一条请求(requestId → 发起的 App socket)。 */
  track(requestId: string, ws: S, now: number = Date.now()): void {
    this.map.set(requestId, { ws, ts: now });
  }

  /** 取某请求对应的 App socket。 */
  get(requestId: string): S | undefined {
    return this.map.get(requestId)?.ws;
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

  /**
   * 清除已关闭 socket 或超过 TTL 的悬挂请求。返回清除条数。
   * @param isOpen 可选的"是否仍打开"判定(默认按 readyState === OPEN)。
   */
  cleanupStale(
    now: number = Date.now(),
    isOpen: (ws: S) => boolean = (ws) => ws.readyState === WS_OPEN
  ): number {
    let removed = 0;
    for (const [id, e] of this.map) {
      if (!isOpen(e.ws) || now - e.ts > this.ttlMs) {
        this.map.delete(id);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.map.size;
  }
}
