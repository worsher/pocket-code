import { describe, it, expect } from "vitest";
import { AgentEvent, AGENT_EVENT_TYPE_NAMES } from "./agentEvent.js";

describe("wire — AgentEvent validation", () => {
  it("accepts text-delta", () => {
    expect(AgentEvent.safeParse({ type: "text-delta", text: "hi" }).success).toBe(true);
  });

  it("accepts tool-call with args record", () => {
    const r = AgentEvent.safeParse({
      type: "tool-call",
      callId: "c1",
      name: "runCommand",
      args: { command: "ls" },
    });
    expect(r.success).toBe(true);
  });

  it("accepts tool-result with isError omitted", () => {
    expect(
      AgentEvent.safeParse({ type: "tool-result", callId: "c1", result: { ok: 1 } }).success
    ).toBe(true);
  });

  it("accepts file-changed with valid changeType", () => {
    const r = AgentEvent.safeParse({
      type: "file-changed",
      path: "src/a.ts",
      changeType: "modified",
      oldContent: "a",
      newContent: "b",
    });
    expect(r.success).toBe(true);
  });

  it("rejects file-changed with invalid changeType", () => {
    const r = AgentEvent.safeParse({
      type: "file-changed",
      path: "src/a.ts",
      changeType: "renamed",
    });
    expect(r.success).toBe(false);
  });

  it("accepts command-output with stream enum", () => {
    const r = AgentEvent.safeParse({
      type: "command-output",
      callId: "c1",
      chunk: "line\n",
      stream: "stdout",
    });
    expect(r.success).toBe(true);
  });

  it("accepts preview-available", () => {
    const r = AgentEvent.safeParse({
      type: "preview-available",
      url: "http://localhost:3000",
      source: "dev-server",
    });
    expect(r.success).toBe(true);
  });

  it("accepts process-started / process-exited", () => {
    expect(
      AgentEvent.safeParse({ type: "process-started", processId: "p1", command: "npm run dev" })
        .success
    ).toBe(true);
    expect(
      AgentEvent.safeParse({ type: "process-exited", processId: "p1", exitCode: 0 }).success
    ).toBe(true);
  });

  it("accepts usage with non-negative ints", () => {
    expect(
      AgentEvent.safeParse({ type: "usage", inputTokens: 10, outputTokens: 20 }).success
    ).toBe(true);
  });

  it("accepts done and error", () => {
    expect(AgentEvent.safeParse({ type: "done" }).success).toBe(true);
    expect(AgentEvent.safeParse({ type: "error", message: "boom" }).success).toBe(true);
  });

  it("done: bare form and extended stopReason/usage form both round-trip", () => {
    expect(AgentEvent.safeParse({ type: "done" }).success).toBe(true);
    const full = {
      type: "done",
      stopReason: "max_steps",
      usage: { inputTokens: 100, outputTokens: 50 },
    };
    const r = AgentEvent.safeParse(full);
    expect(r.success).toBe(true);
    expect(r.success && r.data).toEqual(full);
    expect(AgentEvent.safeParse({ type: "done", stopReason: "gave_up" }).success).toBe(false);
  });

  it("step-retrying and media-degraded round-trip", () => {
    const retry = {
      type: "step-retrying",
      failedAttempt: 1, nextAttempt: 2, maxAttempts: 5, delayMs: 500,
      statusCode: 429, message: "rate limited",
    };
    const r1 = AgentEvent.safeParse(retry);
    expect(r1.success && r1.data).toEqual(retry);
    // 可选字段缺省合法
    expect(AgentEvent.safeParse({ type: "step-retrying", failedAttempt: 1, nextAttempt: 2, maxAttempts: 5, delayMs: 0 }).success).toBe(true);

    const deg = { type: "media-degraded", level: "degraded", keptImages: 1 };
    const r2 = AgentEvent.safeParse(deg);
    expect(r2.success && r2.data).toEqual(deg);
    expect(AgentEvent.safeParse({ type: "media-degraded", level: "half", keptImages: 0 }).success).toBe(false);
  });

  it("every variant accepts optional seq and round-trips it (P14 C14-1)", () => {
    const withSeq = { type: "text-delta", text: "hi", seq: 42 };
    const r = AgentEvent.safeParse(withSeq);
    expect(r.success && r.data).toEqual(withSeq);
    expect(AgentEvent.safeParse({ type: "done", seq: 1 }).success).toBe(true);
    expect(AgentEvent.safeParse({ type: "tool-result", callId: "c1", result: 1, seq: 7 }).success).toBe(true);
    expect(AgentEvent.safeParse({ type: "text-delta", text: "hi", seq: 0 }).success).toBe(false); // 正整数
    expect(AgentEvent.safeParse({ type: "text-delta", text: "hi" }).success).toBe(true); // 缺省合法
  });

  it("history-compacted round-trips (P15)", () => {
    const full = {
      type: "history-compacted",
      tokensBefore: 70000, tokensAfter: 9000,
      compactedMessages: 42, keptRecentTurns: 2, seq: 5,
    };
    const r = AgentEvent.safeParse(full);
    expect(r.success && r.data).toEqual(full);
    expect(AgentEvent.safeParse({ type: "history-compacted", tokensBefore: 1 }).success).toBe(false); // 缺字段
    expect(AGENT_EVENT_TYPE_NAMES).toContain("history-compacted"); // 派生集合自动路由(P13 T6 收益)
  });

  it("AGENT_EVENT_TYPE_NAMES covers every union variant exactly once", () => {
    expect(new Set(AGENT_EVENT_TYPE_NAMES).size).toBe(AgentEvent.options.length);
    expect(AGENT_EVENT_TYPE_NAMES).toContain("step-retrying");
    expect(AGENT_EVENT_TYPE_NAMES).toContain("media-degraded");
    expect(AGENT_EVENT_TYPE_NAMES).toContain("done");
  });

  it("rejects unknown event type", () => {
    expect(AgentEvent.safeParse({ type: "totally-unknown" }).success).toBe(false);
  });

  it("rejects tool-call missing name", () => {
    expect(
      AgentEvent.safeParse({ type: "tool-call", callId: "c1", args: {} }).success
    ).toBe(false);
  });
});
