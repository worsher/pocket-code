import { describe, expect, it } from "vitest";
import { isCliEvent } from "./isCliEvent.js";

describe("isCliEvent", () => {
  it("接受全部 7 个变体", () => {
    expect(isCliEvent({ type: "text-delta", text: "hi" })).toBe(true);
    expect(isCliEvent({ type: "reasoning-delta", text: "t" })).toBe(true);
    expect(isCliEvent({ type: "tool-call", callId: "c1", name: "readFile", args: { path: "a" } })).toBe(true);
    expect(isCliEvent({ type: "tool-result", callId: "c1", result: { ok: 1 } })).toBe(true);
    expect(isCliEvent({ type: "tool-result", callId: "c1", result: "s", isError: true })).toBe(true);
    expect(isCliEvent({ type: "usage", inputTokens: 10, outputTokens: 20 })).toBe(true);
    expect(isCliEvent({ type: "done" })).toBe(true);
    expect(isCliEvent({ type: "error", message: "boom" })).toBe(true);
    expect(isCliEvent({ type: "error", message: "boom", code: "E1" })).toBe(true);
  });

  it("拒绝未知 type 与非对象", () => {
    expect(isCliEvent({ type: "totally-unknown" })).toBe(false);
    expect(isCliEvent(null)).toBe(false);
    expect(isCliEvent("text-delta")).toBe(false);
    expect(isCliEvent(undefined)).toBe(false);
  });

  it("拒绝缺字段/错类型", () => {
    expect(isCliEvent({ type: "text-delta" })).toBe(false); // 缺 text
    expect(isCliEvent({ type: "tool-call", callId: "c1", args: {} })).toBe(false); // 缺 name
    expect(isCliEvent({ type: "tool-call", callId: "c1", name: "x", args: "not-obj" })).toBe(false);
    expect(isCliEvent({ type: "usage", inputTokens: -1, outputTokens: 0 })).toBe(false); // 负数
    expect(isCliEvent({ type: "usage", inputTokens: 1.5, outputTokens: 0 })).toBe(false); // 非整数
    expect(isCliEvent({ type: "error" })).toBe(false); // 缺 message
    expect(isCliEvent({ type: "tool-result", callId: "c1", result: 1, isError: "yes" })).toBe(false); // isError 非 bool
  });
});
