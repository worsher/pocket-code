// ── 瞬时错误重试基元(spec 2026-07-21 §4.2,常数对齐 kimi-code loop/retry.ts)──
// 零依赖同构包:sleep 自实现(setTimeout + AbortSignal),不引任何工具库。

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 32_000;
const FACTOR = 2;
const JITTER = 0.25;

/** 第 n 次重试前的等待序列:min(base·2^(n-1), 32s) 上浮 ≤25% jitter(C13-1)。 */
export function retryBackoffDelays(maxAttempts: number, baseMs = BASE_DELAY_MS): number[] {
  const count = Math.max(maxAttempts - 1, 0);
  const delays: number[] = [];
  for (let i = 0; i < count; i++) {
    const base = Math.min(baseMs * FACTOR ** i, MAX_DELAY_MS);
    delays.push(base + Math.random() * JITTER * base);
  }
  return delays;
}

/** 可中断等待:abort 时立即 reject(AbortError 语义);已 aborted 的 signal 直接 reject。 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abortErr = () => new DOMException("The operation was aborted.", "AbortError");
    if (signal?.aborted) {
      reject(abortErr());
      return;
    }
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(abortErr());
    };
    signal?.addEventListener("abort", onAbort);
  });
}
