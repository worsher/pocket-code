// ── P14:per-session 事件流(seq 分配 + 环形缓冲 + epoch + 订阅 fan-out) ──
// spec 2026-07-21 §5:流式 AgentEvent 经 publish 获得单调 seq 并入环,断线期间
// turn 继续产出进缓冲,重连时 init 携带 lastSeq 由 readSince 补发缺口。
// 订阅表(D-P14-1):旧连接的 send 闭包在断线后已死,新连接经 subscribe 接上
// 进行中 turn 的实时流;publish = 分配 seq → 入环 → 广播全部订阅者。
// 不截断事件(D-P14-2,C14-2 逐字段相等优先):条数+字节双上限整条淘汰,
// 淘汰造成的覆盖不足由 readSince 返回 null → 上层发 resync-required。

import type { AgentEventType } from "@pocket-code/wire";

/** 环形缓冲条数上限(导出供测试构造淘汰场景)。 */
export const _MAX_EVENTS = 2000;
const MAX_BYTES = 8 * 1024 * 1024; // 8MB
const STREAM_TTL_MS = 30 * 60 * 1000; // 与 messageHandler 的 session TTL 一致
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

export interface SessionEventStream {
  readonly epoch: string;
  /** 最后分配的 seq(0 = 尚无事件)。 */
  readonly seq: number;
  /** 分配 seq → 存入环 → 广播给全部订阅者(send 抛错静默忽略该订阅者)。返回带 seq 的事件。 */
  publish(ev: AgentEventType): AgentEventType;
  /** 注册实时投递回调;返回退订函数。 */
  subscribe(send: (ev: AgentEventType) => void): () => void;
  /** seq > fromSeq 的全部缓冲事件;覆盖不足(缺口已被淘汰)返回 null。 */
  readSince(fromSeq: number): AgentEventType[] | null;
}

interface BufferedEntry {
  ev: AgentEventType;
  bytes: number;
}

class SessionEventStreamImpl implements SessionEventStream {
  readonly epoch = `ep_${crypto.randomUUID()}`;
  private _seq = 0;
  private entries: BufferedEntry[] = [];
  private totalBytes = 0;
  private subscribers = new Set<(ev: AgentEventType) => void>();
  lastActivity = Date.now();

  get seq(): number {
    return this._seq;
  }

  publish(ev: AgentEventType): AgentEventType {
    this._seq += 1;
    this.lastActivity = Date.now();
    const stored: AgentEventType = { ...ev, seq: this._seq };
    const bytes = JSON.stringify(stored).length;
    this.entries.push({ ev: stored, bytes });
    this.totalBytes += bytes;
    // 双上限整条淘汰(至少保留最新一条)
    while (
      this.entries.length > 1 &&
      (this.entries.length > _MAX_EVENTS || this.totalBytes > MAX_BYTES)
    ) {
      const evicted = this.entries.shift()!;
      this.totalBytes -= evicted.bytes;
    }
    for (const send of this.subscribers) {
      try {
        send(stored);
      } catch {
        // 死连接的 send:忽略,交由该连接的 onClose 退订
      }
    }
    return stored;
  }

  subscribe(send: (ev: AgentEventType) => void): () => void {
    this.subscribers.add(send);
    return () => {
      this.subscribers.delete(send);
    };
  }

  readSince(fromSeq: number): AgentEventType[] | null {
    if (fromSeq >= this._seq) return [];
    const first = this.entries[0];
    // 缓冲为空但曾有事件,或头部之前存在已淘汰的缺口 → 覆盖不足
    if (!first || (first.ev.seq as number) > fromSeq + 1) return null;
    return this.entries.filter((e) => (e.ev.seq as number) > fromSeq).map((e) => e.ev);
  }

  /** Permanently detach a deleted session from every old transport reference. */
  dispose(): void {
    this.entries = [];
    this.totalBytes = 0;
    this.subscribers.clear();
  }
}

const streams = new Map<string, SessionEventStreamImpl>();

/** 按 sessionId 取/建流;30min 无 publish 由定时清理回收(epoch 随之更换)。 */
export function getSessionStream(sessionId: string): SessionEventStream {
  let stream = streams.get(sessionId);
  if (!stream) {
    stream = new SessionEventStreamImpl();
    streams.set(sessionId, stream);
  }
  return stream;
}

/** Remove buffered events and subscribers when the owning session is deleted. */
export function deleteSessionStream(sessionId: string): boolean {
  const stream = streams.get(sessionId);
  if (!stream) return false;
  stream.dispose();
  streams.delete(sessionId);
  return true;
}

/** 测试辅助:清空注册表(隔离用)。 */
export function _resetStreams(): void {
  streams.clear();
}

setInterval(() => {
  const now = Date.now();
  for (const [id, stream] of streams) {
    if (now - stream.lastActivity > STREAM_TTL_MS) streams.delete(id);
  }
}, CLEANUP_INTERVAL_MS).unref();
