import { describe, it, expect } from "vitest";
import type { AgentEventType } from "@pocket-code/wire";
import { createAgentEventToStreamEvent } from "./bridge.js";

describe("createAgentEventToStreamEvent", () => {
  it("passes text-delta / reasoning-delta / done through unchanged", () => {
    const c = createAgentEventToStreamEvent();
    expect(c({ type: "text-delta", text: "a" })).toEqual({ type: "text-delta", text: "a" });
    expect(c({ type: "reasoning-delta", text: "t" })).toEqual({ type: "reasoning-delta", text: "t" });
    expect(c({ type: "done" })).toEqual({ type: "done" });
  });

  it("maps tool-call to old shape and remembers callId→name for tool-result", () => {
    const c = createAgentEventToStreamEvent();
    const call: AgentEventType = { type: "tool-call", callId: "id1", name: "runCommand", args: { command: "ls" } };
    expect(c(call)).toEqual({ type: "tool-call", toolName: "runCommand", args: { command: "ls" } });
    const result: AgentEventType = { type: "tool-result", callId: "id1", result: "ok", isError: false };
    expect(c(result)).toEqual({ type: "tool-result", toolName: "runCommand", result: "ok" });
  });

  it("uses empty toolName when tool-result has no matching prior call", () => {
    const c = createAgentEventToStreamEvent();
    expect(c({ type: "tool-result", callId: "unknown", result: "r" })).toEqual({
      type: "tool-result",
      toolName: "",
      result: "r",
    });
  });

  it("maps usage to prompt/completion/total tokens", () => {
    const c = createAgentEventToStreamEvent();
    expect(c({ type: "usage", inputTokens: 10, outputTokens: 20 })).toEqual({
      type: "usage",
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
    });
  });

  it("maps error message and model-selected/file-changed field names", () => {
    const c = createAgentEventToStreamEvent();
    expect(c({ type: "error", message: "boom" })).toEqual({ type: "error", error: "boom" });
    expect(c({ type: "model-selected", modelKey: "claude-sonnet", reason: "complex" })).toEqual({
      type: "model-selected",
      model: "claude-sonnet",
      reason: "complex",
    });
    expect(c({ type: "file-changed", path: "a.ts", changeType: "modified" })).toEqual({
      type: "file-changed",
      path: "a.ts",
      action: "modified",
    });
  });

  it("returns null for events with no old-StreamEvent equivalent (command-output/process/preview)", () => {
    const c = createAgentEventToStreamEvent();
    expect(c({ type: "command-output", callId: "c", chunk: "x", stream: "stdout" })).toBeNull();
    expect(c({ type: "process-started", processId: "p", command: "npm" })).toBeNull();
    expect(c({ type: "process-exited", processId: "p", exitCode: 0 })).toBeNull();
    expect(c({ type: "preview-available", url: "http://x", source: "dev-server" })).toBeNull();
  });
});
