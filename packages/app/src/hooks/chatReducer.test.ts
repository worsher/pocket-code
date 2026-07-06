import { describe, it, expect } from "vitest";
import { applyAgentEvent, phaseFor, type Message } from "./chatReducer";

const base = (over: Partial<Message> = {}): Message[] => [
  { id: "1", role: "user", content: "hi", timestamp: 1 },
  { id: "2", role: "assistant", content: "", toolCalls: [], timestamp: 2, ...over },
];

describe("applyAgentEvent", () => {
  it("appends text-delta to last assistant content", () => {
    const out = applyAgentEvent(base(), { type: "text-delta", text: "he" });
    const out2 = applyAgentEvent(out, { type: "text-delta", text: "llo" });
    expect(out2[1].content).toBe("hello");
    expect(out2[0]).toBe(out[0]); // 未动的消息保持引用
  });

  it("appends reasoning-delta to thinking", () => {
    const out = applyAgentEvent(base(), { type: "reasoning-delta", text: "mm" });
    expect(out[1].thinking).toBe("mm");
  });

  it("records tool-call and pairs tool-result by callId (并发同名工具不错配)", () => {
    let msgs = base();
    msgs = applyAgentEvent(msgs, { type: "tool-call", callId: "c1", name: "readFile", args: { path: "a" } });
    msgs = applyAgentEvent(msgs, { type: "tool-call", callId: "c2", name: "readFile", args: { path: "b" } });
    msgs = applyAgentEvent(msgs, { type: "tool-result", callId: "c2", result: "B" });
    const tcs = msgs[1].toolCalls!;
    expect(tcs[0].result).toBeUndefined();
    expect(tcs[1].result).toBe("B");
  });

  it("falls back to first unresolved call when callId unmatched", () => {
    let msgs = base();
    msgs = applyAgentEvent(msgs, { type: "tool-call", callId: "c1", name: "x", args: {} });
    msgs = applyAgentEvent(msgs, { type: "tool-result", callId: "zz", result: 1 });
    expect(msgs[1].toolCalls![0].result).toBe(1);
  });

  it("sets modelUsed on model-selected and appends error text", () => {
    let msgs = base();
    msgs = applyAgentEvent(msgs, { type: "model-selected", modelKey: "deepseek-v3", reason: "simple" });
    expect(msgs[1].modelUsed).toBe("deepseek-v3");
    msgs = applyAgentEvent(msgs, { type: "error", message: "boom" });
    expect(msgs[1].content).toContain("Error: boom");
  });

  it("returns same reference for ignored events and when last is not assistant", () => {
    const msgs = base();
    expect(applyAgentEvent(msgs, { type: "done" })).toBe(msgs);
    expect(applyAgentEvent(msgs, { type: "usage", inputTokens: 1, outputTokens: 2 })).toBe(msgs);
    expect(applyAgentEvent(msgs, { type: "file-changed", path: "a", changeType: "modified" })).toBe(msgs);
    const userOnly: Message[] = [{ id: "1", role: "user", content: "x", timestamp: 1 }];
    expect(applyAgentEvent(userOnly, { type: "text-delta", text: "y" })).toBe(userOnly);
  });

  it("returns same reference when tool-result finds no unresolved call", () => {
    let msgs = applyAgentEvent(
      [
        { id: "1", role: "user", content: "hi", timestamp: 1 },
        { id: "2", role: "assistant", content: "", toolCalls: [], timestamp: 2 },
      ],
      { type: "tool-call", callId: "c1", name: "x", args: {} }
    );
    msgs = applyAgentEvent(msgs, { type: "tool-result", callId: "c1", result: 1 });
    const after = applyAgentEvent(msgs, { type: "tool-result", callId: "c9", result: 2 });
    expect(after).toBe(msgs); // 全部已完成,落空 → 原引用
  });
});

describe("phaseFor", () => {
  it("maps events to streaming phases", () => {
    expect(phaseFor({ type: "reasoning-delta", text: "" })).toBe("thinking");
    expect(phaseFor({ type: "text-delta", text: "" })).toBe("generating");
    expect(phaseFor({ type: "tool-call", callId: "c", name: "n", args: {} })).toBe("tool-calling");
    expect(phaseFor({ type: "tool-result", callId: "c", result: 1 })).toBe("generating");
    expect(phaseFor({ type: "done" })).toBe("idle");
    expect(phaseFor({ type: "error", message: "e" })).toBe("idle");
    expect(phaseFor({ type: "usage", inputTokens: 0, outputTokens: 0 })).toBeNull();
  });
});
