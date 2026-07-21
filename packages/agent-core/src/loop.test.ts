import { describe, it, expect, vi } from "vitest";
import { runAgentLoop } from "./loop.js";
import { makeFakeBackend } from "./tools/testFakes.js";
import type { ModelClient, ModelDelta } from "./types.js";

/** 每次 streamStep 弹出下一段脚本 */
function scriptedClient(steps: ModelDelta[][]): ModelClient & { calls: any[] } {
  let i = 0;
  const calls: any[] = [];
  return {
    calls,
    async *streamStep(req) {
      calls.push(req);
      for (const d of steps[Math.min(i, steps.length - 1)]) yield d;
      i++;
    },
  };
}

const base = (client: ModelClient, over: any = {}) => ({
  modelClient: client,
  backend: makeFakeBackend(),
  workspace: "/ws",
  system: "sys",
  history: [],
  userMessage: "do it",
  onEvent: vi.fn(),
  ...over,
});

class HttpErr extends Error {
  constructor(public statusCode: number, msg = `http ${statusCode}`) { super(msg); }
}

/** 按脚本先抛后成的 client:throwPlan[i] 非空则第 i 次调用抛该错;成功调用顺序消费 okSteps。 */
function flakyClient(throwPlan: (Error | null)[], okSteps: ModelDelta[][]) {
  let call = 0;
  const calls: any[] = [];
  const remaining = [...okSteps];
  const client: ModelClient & { calls: any[] } = {
    calls,
    async *streamStep(req) {
      calls.push(req);
      const plan = throwPlan[call++];
      if (plan) throw plan;
      for (const d of remaining.shift() ?? [{ type: "text", text: "ok" } as ModelDelta]) yield d;
    },
    classifyError(e) {
      const s = (e as HttpErr).statusCode;
      if (s === 413) return "too-large";
      if (s === 415) return "media-rejected";
      if (s === 429 || (s >= 500 && s < 600)) return "retryable";
      return "fatal";
    },
  };
  return client;
}

const IMG_HISTORY = [
  { role: "user" as const, content: [{ type: "text" as const, text: "旧图" }, { type: "image" as const, base64: "OLD", mimeType: "image/png" }] },
  { role: "assistant" as const, content: "ok" },
];

describe("runAgentLoop", () => {
  it("single step without tools: streams text, returns fullText, no done event", async () => {
    const client = scriptedClient([[{ type: "text", text: "he" }, { type: "text", text: "llo" }]]);
    const onEvent = vi.fn();
    const r = await runAgentLoop(base(client, { onEvent }));
    expect(r.fullText).toBe("hello");
    const types = onEvent.mock.calls.map((c) => c[0].type);
    expect(types).toEqual(["text-delta", "text-delta"]); // 无 usage(0)、无 done
    expect(r.messages.at(-1)).toEqual({ role: "assistant", content: "hello" });
  });

  it("tool round trip: executes via registry, emits call/result/file-changed, feeds next step", async () => {
    const client = scriptedClient([
      [{ type: "tool-call", id: "c1", name: "writeFile", args: { path: "n.ts", content: "x" } }],
      [{ type: "text", text: "done" }],
    ]);
    const onEvent = vi.fn();
    await runAgentLoop(base(client, { onEvent }));
    const evs = onEvent.mock.calls.map((c) => c[0]);
    expect(evs.map((e) => e.type)).toEqual(["tool-call", "file-changed", "tool-result", "text-delta"]);
    expect(evs[0]).toMatchObject({ callId: "c1", name: "writeFile" });
    expect(evs[1]).toMatchObject({ path: "n.ts", changeType: "created" });
    // 第二步收到 tool 消息
    expect(client.calls[1].messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "c1" });
  });

  it("failed tool marks isError and loop continues", async () => {
    const client = scriptedClient([
      [{ type: "tool-call", id: "c1", name: "readFile", args: { path: "nope.ts" } }],
      [{ type: "text", text: "recovered" }],
    ]);
    const onEvent = vi.fn();
    const r = await runAgentLoop(base(client, { onEvent }));
    const result = onEvent.mock.calls.map((c) => c[0]).find((e) => e.type === "tool-result");
    expect(result.isError).toBe(true);
    expect(r.fullText).toBe("recovered");
  });

  // I-1:工具 execute 裸抛(如 runCommandTool 遇 backend.exec 同步抛出,对照 App geek 本地
  // 路径 native 模块缺失场景)时,registry.run 归一为 {success:false,error},loop 不应 reject,
  // 应发出 isError 的 tool-result 事件并继续循环到正常结束(对照上面 "failed tool marks isError
  // and loop continues" 用例)。
  it("I-1: tool execute throwing does not reject the loop; emits isError tool-result and continues", async () => {
    const client = scriptedClient([
      [{ type: "tool-call", id: "c1", name: "runCommand", args: { command: "ls" } }],
      [{ type: "text", text: "recovered" }],
    ]);
    const onEvent = vi.fn();
    const backend = makeFakeBackend({
      exec: vi.fn(async () => {
        throw new Error("native module missing");
      }),
    });
    const r = await runAgentLoop(base(client, { onEvent, backend }));
    const result = onEvent.mock.calls.map((c) => c[0]).find((e: any) => e.type === "tool-result");
    expect(result.isError).toBe(true);
    expect(r.fullText).toBe("recovered");
  });

  it("respects maxSteps", async () => {
    const client = scriptedClient([[{ type: "tool-call", id: "x", name: "listFiles", args: { path: "." } }]]);
    await runAgentLoop(base(client, { maxSteps: 3 }));
    expect(client.calls.length).toBe(3);
  });

  it("abort between steps stops the loop", async () => {
    const ac = new AbortController();
    const client = scriptedClient([[{ type: "tool-call", id: "x", name: "listFiles", args: { path: "." } }]]);
    const onEvent = vi.fn(() => ac.abort());
    const r = await runAgentLoop(base(client, { signal: ac.signal, onEvent }));
    expect(client.calls.length).toBe(1);
    expect(r).toBeDefined(); // 不抛
  });

  it("aggregated usage emitted once; images become content parts", async () => {
    const client = scriptedClient([
      [{ type: "usage", inputTokens: 10, outputTokens: 5 }, { type: "text", text: "a" }],
    ]);
    const onEvent = vi.fn();
    await runAgentLoop(base(client, { onEvent, images: [{ base64: "AAA", mimeType: "image/png" }] }));
    const usage = onEvent.mock.calls.map((c) => c[0]).filter((e) => e.type === "usage");
    expect(usage).toEqual([{ type: "usage", inputTokens: 10, outputTokens: 5 }]);
    const userMsg = client.calls[0].messages.find((m: any) => m.role === "user");
    expect(Array.isArray(userMsg.content)).toBe(true);
    expect(userMsg.content[1]).toMatchObject({ type: "image", base64: "AAA" });
  });

  it("model error: emits error event, returns stopReason error with partial text in history (D1)", async () => {
    const client: ModelClient = {
      async *streamStep() {
        yield { type: "text", text: "part" } as ModelDelta;
        throw new Error("model down");
      },
    };
    const onEvent = vi.fn();
    const r = await runAgentLoop(base(client, { onEvent }));   // 不再 rejects
    expect(r.stopReason).toBe("error");
    expect(r.errorMessage).toBe("model down");
    expect(onEvent.mock.calls.at(-1)![0]).toMatchObject({ type: "error", message: "model down" });
    // 部分文本入史:纯文本 assistant,无 toolCalls(C12-5)
    expect(r.messages.at(-1)).toEqual({ role: "assistant", content: "part" });
  });

  it("stopReason end_turn on natural finish; usage/steps aggregated in result", async () => {
    const client = scriptedClient([
      [{ type: "usage", inputTokens: 10, outputTokens: 5 },
       { type: "tool-call", id: "c1", name: "listFiles", args: { path: "." } }],
      [{ type: "usage", inputTokens: 3, outputTokens: 2 }, { type: "text", text: "done" }],
    ]);
    const r = await runAgentLoop(base(client));
    expect(r.stopReason).toBe("end_turn");
    expect(r.usage).toEqual({ inputTokens: 13, outputTokens: 7 });
    expect(r.steps).toBe(2);
    expect(r.errorMessage).toBeUndefined();
  });

  it("stopReason max_steps when budget exhausts with pending tool intent (C12-2)", async () => {
    const client = scriptedClient([[{ type: "tool-call", id: "x", name: "listFiles", args: { path: "." } }]]);
    const r = await runAgentLoop(base(client, { maxSteps: 3 }));
    expect(client.calls.length).toBe(3);
    expect(r.stopReason).toBe("max_steps");
    expect(r.steps).toBe(3);
    // 消息不变量:第 3 步的 toolCalls 已执行、已配对(C12-5)
    expect((r.messages.at(-1) as any).role).toBe("tool");
  });

  it("final step without toolCalls is end_turn, not max_steps", async () => {
    const client = scriptedClient([
      [{ type: "tool-call", id: "c1", name: "listFiles", args: { path: "." } }],
      [{ type: "text", text: "fin" }],
    ]);
    const r = await runAgentLoop(base(client, { maxSteps: 2 }));
    expect(r.stopReason).toBe("end_turn");
  });

  it("stopReason aborted on mid-loop abort (existing I-1 path)", async () => {
    const ac = new AbortController();
    const client = scriptedClient([[{ type: "tool-call", id: "x", name: "listFiles", args: { path: "." } }]]);
    const onEvent = vi.fn(() => ac.abort());
    const r = await runAgentLoop(base(client, { signal: ac.signal, onEvent }));
    expect(r.stopReason).toBe("aborted");
  });

  it("streamStep throwing due to abort is aborted, not error; no error event", async () => {
    const ac = new AbortController();
    const client: ModelClient = {
      async *streamStep() {
        ac.abort();
        throw new DOMException("The operation was aborted.", "AbortError");
      },
    };
    const onEvent = vi.fn();
    const r = await runAgentLoop(base(client, { signal: ac.signal, onEvent }));
    expect(r.stopReason).toBe("aborted");
    expect(r.errorMessage).toBeUndefined();
    expect(onEvent.mock.calls.map((c) => c[0].type)).not.toContain("error");
  });

  it("I-1: abort between tool calls synthesizes an aborted tool message for the un-executed call", async () => {
    const ac = new AbortController();
    const client = scriptedClient([
      [
        { type: "tool-call", id: "c1", name: "readFile", args: { path: "a.ts" } },
        { type: "tool-call", id: "c2", name: "readFile", args: { path: "a.ts" } },
      ],
    ]);
    const onEvent = vi.fn((ev: any) => {
      if (ev.type === "tool-result") ac.abort();
    });
    const backend = makeFakeBackend();
    const r = await runAgentLoop(base(client, { signal: ac.signal, onEvent, backend }));

    // 第二个工具没有真正执行
    expect((backend.readFile as any).mock.calls.length).toBe(1);

    const toolMsgs = r.messages.filter((m: any) => m.role === "tool");
    expect(toolMsgs.length).toBe(2);
    expect(toolMsgs[0]).toMatchObject({ toolCallId: "c1" });
    expect(JSON.parse((toolMsgs[0] as any).content).success).toBe(true);
    expect(toolMsgs[1]).toEqual({
      role: "tool",
      toolCallId: "c2",
      toolName: "readFile",
      content: JSON.stringify({ success: false, error: "aborted" }),
    });

    // 合成消息不发任何事件:tool-call/tool-result 事件只针对 c1
    const toolEventCallIds = onEvent.mock.calls
      .map((c) => c[0])
      .filter((e: any) => e.type === "tool-call" || e.type === "tool-result")
      .map((e: any) => e.callId);
    expect(toolEventCallIds).toEqual(["c1", "c1"]);
  });

  it("M-1: usage accumulates across multiple steps", async () => {
    const client = scriptedClient([
      [
        { type: "usage", inputTokens: 10, outputTokens: 5 },
        { type: "tool-call", id: "c1", name: "listFiles", args: { path: "." } },
      ],
      [{ type: "usage", inputTokens: 3, outputTokens: 2 }, { type: "text", text: "done" }],
    ]);
    const onEvent = vi.fn();
    await runAgentLoop(base(client, { onEvent }));
    const usage = onEvent.mock.calls.map((c) => c[0]).filter((e) => e.type === "usage");
    expect(usage).toEqual([{ type: "usage", inputTokens: 13, outputTokens: 7 }]);
  });

  it("usage with explicit zero deltas across steps does not emit a summary event", async () => {
    const client = scriptedClient([
      [
        { type: "usage", inputTokens: 0, outputTokens: 0 },
        { type: "tool-call", id: "c1", name: "listFiles", args: { path: "." } },
      ],
      [{ type: "usage", inputTokens: 0, outputTokens: 0 }, { type: "text", text: "done" }],
    ]);
    const onEvent = vi.fn();
    await runAgentLoop(base(client, { onEvent }));
    const usage = onEvent.mock.calls.map((c) => c[0]).filter((e) => e.type === "usage");
    expect(usage).toEqual([]);
  });

  it("retryable: 429 twice then success — two step-retrying events, final text ok (C13-1/6)", async () => {
    const client = flakyClient([new HttpErr(429), new HttpErr(429), null], [[{ type: "text", text: "ok" }]]);
    const onEvent = vi.fn();
    const r = await runAgentLoop(base(client, { onEvent, retryBaseMs: 1 }));
    expect(r.stopReason).toBe("end_turn");
    expect(r.fullText).toBe("ok");
    const retries = onEvent.mock.calls.map((c) => c[0]).filter((e: any) => e.type === "step-retrying");
    expect(retries.length).toBe(2);
    expect(retries[0]).toMatchObject({ failedAttempt: 1, nextAttempt: 2, maxAttempts: 5, statusCode: 429 });
  });

  it("retryable exhausted → stopReason error after maxRetryAttempts attempts", async () => {
    const client = flakyClient(Array(10).fill(new HttpErr(503)), []);
    const onEvent = vi.fn();
    const r = await runAgentLoop(base(client, { onEvent, retryBaseMs: 1, maxRetryAttempts: 3 }));
    expect(r.stopReason).toBe("error");
    expect(client.calls.length).toBe(3); // 尝试总数 = maxRetryAttempts
    expect(onEvent.mock.calls.map((c) => c[0]).filter((e: any) => e.type === "step-retrying").length).toBe(2);
  });

  it("413 → degraded resend: media-degraded emitted, request retried with projection (C13-2/6)", async () => {
    const client = flakyClient([new HttpErr(413), null], [[{ type: "text", text: "ok" }]]);
    const onEvent = vi.fn();
    const r = await runAgentLoop(base(client, { onEvent, history: IMG_HISTORY }));
    expect(r.stopReason).toBe("end_turn");
    const deg = onEvent.mock.calls.map((c) => c[0]).find((e: any) => e.type === "media-degraded");
    expect(deg).toEqual({ type: "media-degraded", level: "degraded", keptImages: 1 });
    // degraded 保留全局最后一张:OLD 是唯一图 → 仍在第 2 次请求里
    expect(JSON.stringify(client.calls[1].messages)).toContain("OLD");
    // C13-3:history 本体未被投影污染
    expect(JSON.stringify(r.messages)).toContain("OLD");
  });

  it("413 twice → stripped sticky: later steps stay stripped without re-rejection (C13-2, 粘性)", async () => {
    const client = flakyClient(
      [new HttpErr(413), new HttpErr(413), null, null],
      [[{ type: "tool-call", id: "c1", name: "listFiles", args: { path: "." } }], [{ type: "text", text: "fin" }]],
    );
    const onEvent = vi.fn();
    const r = await runAgentLoop(base(client, { onEvent, history: IMG_HISTORY }));
    expect(r.stopReason).toBe("end_turn");
    const degLevels = onEvent.mock.calls.map((c) => c[0]).filter((e: any) => e.type === "media-degraded").map((e: any) => e.level);
    expect(degLevels).toEqual(["degraded", "stripped"]);
    // 第 4 次调用(第 2 个 step)直接 stripped 投影:无 OLD、无第 3 次 413
    expect(JSON.stringify(client.calls[3].messages)).not.toContain("OLD");
    expect(client.calls.length).toBe(4);
  });

  it("413 on stripped projection → error (C13-2 终点)", async () => {
    const client = flakyClient([new HttpErr(413), new HttpErr(413), new HttpErr(413)], []);
    const r = await runAgentLoop(base(client, { history: IMG_HISTORY }));
    expect(r.stopReason).toBe("error");
    expect(client.calls.length).toBe(3); // normal→degraded→stripped 各一次
  });

  it("media-rejected jumps straight to stripped", async () => {
    const client = flakyClient([new HttpErr(415), null], [[{ type: "text", text: "ok" }]]);
    const onEvent = vi.fn();
    const r = await runAgentLoop(base(client, { onEvent, history: IMG_HISTORY }));
    expect(r.stopReason).toBe("end_turn");
    const deg = onEvent.mock.calls.map((c) => c[0]).find((e: any) => e.type === "media-degraded");
    expect(deg).toMatchObject({ level: "stripped", keptImages: 0 });
    expect(JSON.stringify(client.calls[1].messages)).not.toContain("OLD");
  });

  it("D-P13-1: partial output before a retryable error → no retry, stopReason error", async () => {
    const client: ModelClient = {
      async *streamStep() {
        yield { type: "text", text: "half" } as ModelDelta;
        throw new HttpErr(503);
      },
      classifyError: () => "retryable",
    };
    const onEvent = vi.fn();
    const r = await runAgentLoop(base(client, { onEvent, retryBaseMs: 1 }));
    expect(r.stopReason).toBe("error");
    expect(onEvent.mock.calls.map((c) => c[0].type)).not.toContain("step-retrying");
    expect(r.messages.at(-1)).toEqual({ role: "assistant", content: "half" }); // T1 部分入史语义仍成立
  });

  it("abort during retry sleep → aborted promptly, no further requests (C13-5)", async () => {
    const ac = new AbortController();
    const client = flakyClient([new HttpErr(429)], []);
    const onEvent = vi.fn((ev: any) => {
      if (ev.type === "step-retrying") ac.abort();
    });
    const t0 = Date.now();
    const r = await runAgentLoop(base(client, { onEvent, signal: ac.signal, retryBaseMs: 60_000 }));
    expect(r.stopReason).toBe("aborted");
    expect(client.calls.length).toBe(1); // abort 后不再发起新请求
    expect(Date.now() - t0).toBeLessThan(5_000); // 60s 退避被立即打断
  });

  it("editFile success emits file-changed with changeType modified", async () => {
    const client = scriptedClient([
      [{ type: "tool-call", id: "c1", name: "editFile", args: { path: "a.ts", oldText: "hello", newText: "hi" } }],
      [{ type: "text", text: "done" }],
    ]);
    const onEvent = vi.fn();
    await runAgentLoop(base(client, { onEvent }));
    const fileChanged = onEvent.mock.calls.map((c) => c[0]).find((e: any) => e.type === "file-changed");
    expect(fileChanged).toMatchObject({ path: "a.ts", changeType: "modified" });
  });
});
