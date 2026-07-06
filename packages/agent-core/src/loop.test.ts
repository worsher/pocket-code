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

  it("model error: emits error event then rethrows", async () => {
    const client: ModelClient = { async *streamStep() { throw new Error("model down"); } };
    const onEvent = vi.fn();
    await expect(runAgentLoop(base(client, { onEvent }))).rejects.toThrow("model down");
    expect(onEvent.mock.calls.at(-1)![0]).toMatchObject({ type: "error", message: "model down" });
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
