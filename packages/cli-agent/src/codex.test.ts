import { describe, it, expect } from "vitest";
import { isCliEvent } from "./isCliEvent.js";
import { codexAdapter } from "./codex.js";

const P = (obj: unknown) => codexAdapter.parseLine(JSON.stringify(obj));

describe("codexAdapter.parseLine", () => {
  it("ignores thread/turn lifecycle and junk lines", () => {
    expect(P({ type: "thread.started", thread_id: "019f" })).toEqual([]);
    expect(P({ type: "turn.started" })).toEqual([]);
    expect(codexAdapter.parseLine("not json")).toEqual([]);
    expect(codexAdapter.parseLine("")).toEqual([]);
  });

  it("returns [] for valid JSON that is not an object (null/number/string)", () => {
    for (const line of ["null", "42", "true", "\"str\""]) {
      expect(codexAdapter.parseLine(line)).toEqual([]);
    }
  });

  it("maps agent_message to text-delta (真机 fixture)", () => {
    expect(P({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Hi there friend" } }))
      .toEqual([{ type: "text-delta", text: "Hi there friend" }]);
  });

  it("maps reasoning to reasoning-delta, skipping empty text", () => {
    expect(P({ type: "item.completed", item: { id: "r1", type: "reasoning", text: "think" } }))
      .toEqual([{ type: "reasoning-delta", text: "think" }]);
    expect(P({ type: "item.completed", item: { id: "r2", type: "reasoning", text: "" } })).toEqual([]);
  });

  it("maps command_execution started/completed to tool-call/tool-result (真机 fixture,失败命令 isError)", () => {
    const started = P({
      type: "item.started",
      item: { id: "item_0", type: "command_execution", command: "/bin/zsh -lc \"sed -n ...\"", aggregated_output: "", exit_code: null, status: "in_progress" },
    });
    expect(started).toEqual([
      { type: "tool-call", callId: "item_0", name: "runCommand", args: { command: "/bin/zsh -lc \"sed -n ...\"" } },
    ]);
    const completed = P({
      type: "item.completed",
      item: { id: "item_0", type: "command_execution", command: "...", aggregated_output: "sed: ...: No such file or directory\n", exit_code: 1, status: "failed" },
    });
    expect(completed).toEqual([
      { type: "tool-result", callId: "item_0", result: { output: "sed: ...: No such file or directory\n", exitCode: 1 }, isError: true },
    ]);
    // 成功命令无 isError
    const ok = P({
      type: "item.completed",
      item: { id: "i2", type: "command_execution", command: "ls", aggregated_output: "a\n", exit_code: 0, status: "completed" },
    });
    expect((ok[0] as any).isError).toBeUndefined();
  });

  it("maps file_change changes to file-changed events (add/update/delete)", () => {
    const evs = P({
      type: "item.completed",
      item: { id: "f1", type: "file_change", status: "completed", changes: [
        { path: "src/a.ts", kind: "add" },
        { path: "src/b.ts", kind: "update" },
        { path: "src/c.ts", kind: "delete" },
      ]},
    });
    expect(evs).toEqual([
      { type: "file-changed", path: "src/a.ts", changeType: "created" },
      { type: "file-changed", path: "src/b.ts", changeType: "modified" },
      { type: "file-changed", path: "src/c.ts", changeType: "deleted" },
    ]);
  });

  it("maps mcp_tool_call started/completed to tool-call/tool-result", () => {
    const started = P({ type: "item.started", item: { id: "m1", type: "mcp_tool_call", server: "ctx7", tool: "query", status: "in_progress" } });
    expect(started).toEqual([{ type: "tool-call", callId: "m1", name: "ctx7.query", args: {} }]);
    const done = P({ type: "item.completed", item: { id: "m1", type: "mcp_tool_call", server: "ctx7", tool: "query", status: "completed" } });
    expect((done[0] as any)).toMatchObject({ type: "tool-result", callId: "m1" });
  });

  it("maps turn.completed usage and error/turn.failed (真机 fixture)", () => {
    expect(P({ type: "turn.completed", usage: { input_tokens: 33890, cached_input_tokens: 21760, output_tokens: 268, reasoning_output_tokens: 166 } }))
      .toEqual([{ type: "usage", inputTokens: 33890, outputTokens: 268 }]);
    expect(P({ type: "error", message: "stream error: ...; retrying 1/5 in 208ms…" }))
      .toEqual([{ type: "error", message: "stream error: ...; retrying 1/5 in 208ms…" }]);
    expect(P({ type: "turn.failed", error: { message: "exceeded retry limit, last status: 401 Unauthorized" } }))
      .toEqual([{ type: "error", message: "exceeded retry limit, last status: 401 Unauthorized" }]);
  });

  it("ignores unknown item types (todo_list/web_search)", () => {
    expect(P({ type: "item.completed", item: { id: "t", type: "todo_list", items: [] } })).toEqual([]);
    expect(P({ type: "item.updated", item: { id: "x", type: "agent_message", text: "partial" } })).toEqual([]); // 增量忽略
  });

  it("all produced events pass isCliEvent", () => {
    const all = [
      ...P({ type: "item.completed", item: { id: "a", type: "agent_message", text: "x" } }),
      ...P({ type: "item.started", item: { id: "c", type: "command_execution", command: "ls" } }),
      ...P({ type: "item.completed", item: { id: "c", type: "command_execution", command: "ls", aggregated_output: "", exit_code: 0 } }),
      ...P({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } }),
      ...P({ type: "turn.failed", error: { message: "e" } }),
    ];
    for (const ev of all) expect(isCliEvent(ev)).toBe(true);
  });
});

describe("codexAdapter.buildSpawn", () => {
  it("builds codex exec args with json/skip-git-repo-check/bypass, keeps env untouched", () => {
    process.env.__CODEX_TEST_SENTINEL = "keepme";
    const spec = codexAdapter.buildSpawn("do it", { workspace: "/ws" });
    expect(spec.cmd).toBe(process.env.CODEX_CLI_PATH || "codex");
    expect(spec.args).toEqual([
      "exec", "--json",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "do it",
    ]);
    expect(spec.cwd).toBe("/ws");
    expect(spec.env.__CODEX_TEST_SENTINEL).toBe("keepme"); // env 不清理(尊重 config.toml)
    delete process.env.__CODEX_TEST_SENTINEL;
  });

  it("prefixes customPrompt into the message", () => {
    const spec = codexAdapter.buildSpawn("msg", { workspace: "/ws", customPrompt: "rules" });
    expect(spec.args[spec.args.length - 1]).toBe("## Project Instructions\nrules\n\nmsg");
  });
});
