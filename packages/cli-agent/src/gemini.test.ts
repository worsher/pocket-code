import { describe, it, expect } from "vitest";
import { isCliEvent } from "./isCliEvent.js";
import type { CliEvent } from "./types.js";
import { geminiAdapter } from "./gemini.js";

function collect(lines: string[]): CliEvent[] {
  const parse = geminiAdapter.createParser();
  const events: CliEvent[] = [];
  for (const l of lines) events.push(...parse(l));
  return events;
}

describe("geminiAdapter.createParser", () => {
  it("maps assistant message to text-delta", () => {
    const events = collect([JSON.stringify({ type: "message", role: "assistant", content: "hello" })]);
    expect(events).toEqual([{ type: "text-delta", text: "hello" }]);
  });

  it("maps tool_use/tool_result with native tool_id as callId", () => {
    const events = collect([
      JSON.stringify({ type: "tool_use", tool_name: "read_file", tool_id: "t1", parameters: { path: "a" } }),
      JSON.stringify({ type: "tool_result", tool_id: "t1", status: "success", output: { ok: true } }),
    ]);
    expect(events[0]).toEqual({ type: "tool-call", callId: "t1", name: "read_file", args: { path: "a" } });
    expect(events[1]).toEqual({ type: "tool-result", callId: "t1", result: { ok: true } });
  });

  it("synthesizes callId when tool_id missing and flags error results", () => {
    const events = collect([
      JSON.stringify({ type: "tool_use", tool_name: "x", parameters: {} }),
      JSON.stringify({ type: "tool_result", status: "error", output: "boom" }),
    ]);
    expect((events[0] as any).callId).toMatch(/^gm_/);
    expect((events[1] as any).isError).toBe(true);
  });

  it("maps result/error lines to error events; ignores junk; parser state is per-instance", () => {
    const events = collect([
      "not json",
      JSON.stringify({ type: "result", status: "error", error: { message: "failed" } }),
      JSON.stringify({ type: "error", error: "bad" }),
    ]);
    expect(events).toEqual([
      { type: "error", message: "failed" },
      { type: "error", message: "bad" },
    ]);
    // 新实例计数重置
    const again = collect([JSON.stringify({ type: "tool_use", tool_name: "y", parameters: {} })]);
    expect((again[0] as any).callId).toBe("gm_1");
  });

  it("all produced events pass isCliEvent", () => {
    const events = collect([
      JSON.stringify({ type: "message", role: "assistant", content: "a" }),
      JSON.stringify({ type: "tool_use", tool_name: "n", tool_id: "t", parameters: {} }),
      JSON.stringify({ type: "tool_result", tool_id: "t", status: "success", output: {} }),
    ]);
    for (const ev of events) expect(isCliEvent(ev)).toBe(true);
  });
});

describe("geminiAdapter parser robustness", () => {
  it("returns [] for valid JSON that is not an object (null/number/string)", () => {
    const parse = geminiAdapter.createParser();
    for (const line of ["null", "42", "true", "\"str\""]) {
      expect(parse(line)).toEqual([]);
    }
  });
});

describe("geminiAdapter.buildSpawn", () => {
  it("builds gemini exec args with stream-json/yolo/extensions and cleans GCP env", () => {
    const prevModel = process.env.GEMINI_CLI_MODEL;
    delete process.env.GEMINI_CLI_MODEL;
    const spec = geminiAdapter.buildSpawn("do it", { workspace: "/ws" });
    expect(spec.cmd).toBe(process.env.GEMINI_CLI_PATH || "gemini");
    expect(spec.args).toEqual([
      "--prompt", "do it",
      "--output-format", "stream-json",
      "--yolo",
      "--extensions", "__none__",
    ]);
    expect(spec.cwd).toBe("/ws");
    expect(spec.env.GOOGLE_CLOUD_PROJECT).toBeUndefined();
    expect(spec.env.GCLOUD_PROJECT).toBeUndefined();
    if (prevModel !== undefined) process.env.GEMINI_CLI_MODEL = prevModel;
  });

  it("prefixes customPrompt into the message (旧路径丢弃,有意差异)", () => {
    const spec = geminiAdapter.buildSpawn("msg", { workspace: "/ws", customPrompt: "rules" });
    expect(spec.args[1]).toBe("## Project Instructions\nrules\n\nmsg");
  });

  it("respects GEMINI_CLI_MODEL", () => {
    process.env.GEMINI_CLI_MODEL = "gemini-test";
    const spec = geminiAdapter.buildSpawn("m", { workspace: "/ws" });
    expect(spec.args).toContain("--model");
    expect(spec.args).toContain("gemini-test");
    delete process.env.GEMINI_CLI_MODEL;
  });
});
