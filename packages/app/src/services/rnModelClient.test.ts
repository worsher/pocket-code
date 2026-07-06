import { describe, it, expect } from "vitest";
import { callbacksToAsyncIterable, toChatMessages, createRnModelClient } from "./rnModelClient";

// 竞速工具:防止真实挂起把测试拖死——若 for-await 在超时前未终结,race 抛出
// "TIMEOUT",而不是让 vitest 整个进程挂起。
function withTimeout<T>(p: Promise<T>, ms = 500): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), ms)),
  ]);
}

describe("callbacksToAsyncIterable", () => {
  it("yields deltas in order and completes on onDone", async () => {
    const it_ = callbacksToAsyncIterable(({ onDelta, onDone }) => {
      onDelta({ type: "text", text: "a" });
      setTimeout(() => { onDelta({ type: "text", text: "b" }); onDone(); }, 5);
    });
    const got: any[] = [];
    for await (const d of it_) got.push(d);
    expect(got.map((d) => d.text)).toEqual(["a", "b"]);
  });
  it("onError rejects the iteration", async () => {
    const it_ = callbacksToAsyncIterable(({ onError }) => setTimeout(() => onError("boom"), 1));
    await expect((async () => { for await (const _ of it_) {/**/} })()).rejects.toThrow("boom");
  });

  // ── Important #2: 终结状态单向锁,不可被复活 ──────────
  it("ignores onDelta after onDone and keeps returning done:true", async () => {
    let onDeltaRef!: (d: any) => void;
    let onDoneRef!: () => void;
    const it_ = callbacksToAsyncIterable(({ onDelta, onDone }) => {
      onDeltaRef = onDelta;
      onDoneRef = onDone;
    });
    const iterator = it_[Symbol.asyncIterator]();

    onDoneRef();
    const r1 = await iterator.next();
    expect(r1).toEqual({ value: undefined, done: true });

    // 终结后再来 delta,必须被丢弃,不能"复活"迭代器。
    onDeltaRef({ type: "text", text: "late" });
    const r2 = await iterator.next();
    expect(r2.done).toBe(true);
    const r3 = await iterator.next();
    expect(r3.done).toBe(true);
  });

  // ── Important #3: 提前 break 触发 cleanup ────────────
  it("calling iterator.return() marks terminated, drops queue, and further next() stays done", async () => {
    const it_ = callbacksToAsyncIterable(({ onDelta }) => {
      onDelta({ type: "text", text: "a" });
      onDelta({ type: "text", text: "b" });
    });
    const iterator = it_[Symbol.asyncIterator]();
    expect(typeof (iterator as any).return).toBe("function");

    const first = await iterator.next();
    expect(first).toEqual({ value: { type: "text", text: "a" }, done: false });

    const ret = await (iterator as any).return();
    expect(ret).toEqual({ value: undefined, done: true });

    const after = await iterator.next();
    expect(after).toEqual({ value: undefined, done: true });
  });

  it("for-await break triggers cleanup callback", async () => {
    let cleanedUp = false;
    const it_ = callbacksToAsyncIterable(
      ({ onDelta }) => {
        onDelta({ type: "text", text: "a" });
        onDelta({ type: "text", text: "b" });
      },
      () => { cleanedUp = true; }
    );
    for await (const d of it_) {
      expect(d).toEqual({ type: "text", text: "a" });
      break;
    }
    expect(cleanedUp).toBe(true);
  });
});

describe("createRnModelClient abort semantics (Critical #1)", () => {
  it("streamStep for-await throws instead of hanging forever when signal aborts and aiClient never calls back", async () => {
    // 模拟 aiClient.streamChat 的真实 bug 行为:signal abort 时只
    // xhr.abort()+resolve(),不调用任何 callback(onDone/onError 都不触发)。
    // 这里通过 mock streamChat 复刻该行为。
    const controller = new AbortController();

    // 直接构造一个"裸" streamStep 风格的场景:用 callbacksToAsyncIterable
    // 包一层,start 内部注册 abort 监听但不调用任何回调(模拟 aiClient bug),
    // 依赖 rnModelClient 内部的独立 abort 监听来终结迭代。
    // 这里我们通过 createRnModelClient 的真实路径来验证,mock aiClient 模块。
    const rnModelClient = await import("./rnModelClient");
    const client = rnModelClient.createRnModelClientForTest({
      streamChatImpl: (params: any) =>
        new Promise<void>((resolve) => {
          if (params.signal) {
            params.signal.addEventListener("abort", () => {
              // 模拟 aiClient bug:只 resolve,不调用任何 callback。
              resolve();
            });
          }
          // 永不主动完成,除非 abort。
        }),
    });

    const iterable = client.streamStep({
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      signal: controller.signal,
    });

    const run = (async () => {
      const out: any[] = [];
      for await (const d of iterable) out.push(d);
      return out;
    })();

    controller.abort();

    await expect(withTimeout(run)).rejects.toThrow(/aborted/i);
  });

  it("if signal is already aborted before streamStep starts, iteration terminates promptly", async () => {
    const controller = new AbortController();
    controller.abort();

    const rnModelClient = await import("./rnModelClient");
    const client = rnModelClient.createRnModelClientForTest({
      streamChatImpl: () => new Promise<void>(() => {/* never resolves, never calls back */}),
    });

    const iterable = client.streamStep({
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      signal: controller.signal,
    });

    const run = (async () => {
      const out: any[] = [];
      for await (const d of iterable) out.push(d);
      return out;
    })();

    await expect(withTimeout(run)).rejects.toThrow(/aborted/i);
  });
});

describe("toChatMessages", () => {
  it("converts tool round trips to OpenAI shapes", () => {
    const out = toChatMessages([
      { role: "user", content: "hi" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "readFile", args: { path: "a" } }] },
      { role: "tool", toolCallId: "c1", toolName: "readFile", content: "{\"ok\":true}" },
    ]);
    expect(out[1]).toMatchObject({ role: "assistant", tool_calls: [{ id: "c1", function: { name: "readFile" } }] });
    expect(out[2]).toMatchObject({ role: "tool", tool_call_id: "c1" });
  });
  it("converts image parts to data-URI image_url", () => {
    const out = toChatMessages([{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", base64: "AAA", mimeType: "image/png" }] }]);
    expect((out[0] as any).content[1].image_url.url).toBe("data:image/png;base64,AAA");
  });
});
