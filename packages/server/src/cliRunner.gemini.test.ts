import { describe, it, expect } from "vitest";
import { AgentEvent, type AgentEventType } from "@pocket-code/wire";
import { createGeminiLineParser } from "./cliRunner.js";

function collect(lines: string[]): { events: AgentEventType[]; text: string } {
  const parse = createGeminiLineParser();
  const events: AgentEventType[] = [];
  let text = "";
  for (const l of lines) parse(l, (e) => events.push(e), (t) => { text += t; });
  return { events, text };
}

describe("createGeminiLineParser", () => {
  it("maps assistant message to text-delta and accumulates text", () => {
    const { events, text } = collect([
      JSON.stringify({ type: "message", role: "assistant", content: "hello" }),
    ]);
    expect(events).toEqual([{ type: "text-delta", text: "hello" }]);
    expect(text).toBe("hello");
  });

  it("maps tool_use/tool_result with native tool_id as callId", () => {
    const { events } = collect([
      JSON.stringify({ type: "tool_use", tool_name: "read_file", tool_id: "t1", parameters: { path: "a" } }),
      JSON.stringify({ type: "tool_result", tool_id: "t1", status: "success", output: { ok: true } }),
    ]);
    expect(events[0]).toEqual({ type: "tool-call", callId: "t1", name: "read_file", args: { path: "a" } });
    expect(events[1]).toEqual({ type: "tool-result", callId: "t1", result: { ok: true } });
  });

  it("synthesizes callId when tool_id missing and flags error results", () => {
    const { events } = collect([
      JSON.stringify({ type: "tool_use", tool_name: "x", parameters: {} }),
      JSON.stringify({ type: "tool_result", status: "error", output: "boom" }),
    ]);
    expect((events[0] as any).callId).toMatch(/^gm_/);
    expect((events[1] as any).isError).toBe(true);
  });

  it("maps result/error lines to error events; ignores junk", () => {
    const { events } = collect([
      "not json",
      JSON.stringify({ type: "result", status: "error", error: { message: "failed" } }),
      JSON.stringify({ type: "error", error: "bad" }),
    ]);
    expect(events).toEqual([
      { type: "error", message: "failed" },
      { type: "error", message: "bad" },
    ]);
  });

  it("all produced events pass wire AgentEvent.safeParse", () => {
    const { events } = collect([
      JSON.stringify({ type: "message", role: "assistant", content: "a" }),
      JSON.stringify({ type: "tool_use", tool_name: "n", tool_id: "t", parameters: {} }),
      JSON.stringify({ type: "tool_result", tool_id: "t", status: "success", output: {} }),
    ]);
    for (const ev of events) expect(AgentEvent.safeParse(ev).success).toBe(true);
  });
});
