import { describe, it, expect } from "vitest";
import { AgentEvent } from "./agentEvent.js";

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

  it("rejects unknown event type", () => {
    expect(AgentEvent.safeParse({ type: "totally-unknown" }).success).toBe(false);
  });

  it("rejects tool-call missing name", () => {
    expect(
      AgentEvent.safeParse({ type: "tool-call", callId: "c1", args: {} }).success
    ).toBe(false);
  });
});
