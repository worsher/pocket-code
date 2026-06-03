import { describe, it, expect } from "vitest";
import { AgentEvent } from "@pocket-code/wire";
import { claudeCodeAdapter } from "./claudeCode.js";

const line = (obj: unknown) => JSON.stringify(obj);

describe("claudeCodeAdapter.parseLine", () => {
  it("returns [] for blank / non-JSON / system lines", () => {
    expect(claudeCodeAdapter.parseLine("")).toEqual([]);
    expect(claudeCodeAdapter.parseLine("   ")).toEqual([]);
    expect(claudeCodeAdapter.parseLine("not json")).toEqual([]);
    expect(
      claudeCodeAdapter.parseLine(line({ type: "system", subtype: "init", model: "claude" }))
    ).toEqual([]);
    expect(claudeCodeAdapter.parseLine(line({ type: "stream_event", event: {} }))).toEqual([]);
  });

  it("maps assistant text block to text-delta", () => {
    const evs = claudeCodeAdapter.parseLine(
      line({ type: "assistant", message: { content: [{ type: "text", text: "hello" }] } })
    );
    expect(evs).toEqual([{ type: "text-delta", text: "hello" }]);
  });

  it("maps assistant thinking block to reasoning-delta", () => {
    const evs = claudeCodeAdapter.parseLine(
      line({ type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm" }] } })
    );
    expect(evs).toEqual([{ type: "reasoning-delta", text: "hmm" }]);
  });

  it("skips empty thinking blocks (signature-only)", () => {
    const evs = claudeCodeAdapter.parseLine(
      line({ type: "assistant", message: { content: [{ type: "thinking", thinking: "", signature: "x" }] } })
    );
    expect(evs).toEqual([]);
  });

  it("maps tool_use to tool-call with callId/name/args", () => {
    const evs = claudeCodeAdapter.parseLine(
      line({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "tu_1", name: "runCommand", input: { command: "ls" } }],
        },
      })
    );
    expect(evs).toEqual([
      { type: "tool-call", callId: "tu_1", name: "runCommand", args: { command: "ls" } },
    ]);
  });

  it("emits multiple events for a multi-block assistant message", () => {
    const evs = claudeCodeAdapter.parseLine(
      line({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "a" },
            { type: "tool_use", id: "tu_2", name: "readFile", input: { path: "x" } },
          ],
        },
      })
    );
    expect(evs).toHaveLength(2);
    expect(evs[0]).toEqual({ type: "text-delta", text: "a" });
    expect(evs[1]).toMatchObject({ type: "tool-call", callId: "tu_2", name: "readFile" });
  });

  it("maps tool_result (array content) to tool-result with tool_use_id as callId", () => {
    const evs = claudeCodeAdapter.parseLine(
      line({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: "ok" }] },
          ],
        },
      })
    );
    expect(evs).toEqual([{ type: "tool-result", callId: "tu_1", result: "ok", isError: false }]);
  });

  it("maps tool_result with is_error=true and string content", () => {
    const evs = claudeCodeAdapter.parseLine(
      line({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tu_9", content: "boom", is_error: true }],
        },
      })
    );
    expect(evs).toEqual([{ type: "tool-result", callId: "tu_9", result: "boom", isError: true }]);
  });

  it("maps result success with usage to a usage event", () => {
    const evs = claudeCodeAdapter.parseLine(
      line({ type: "result", subtype: "success", usage: { input_tokens: 12, output_tokens: 34 } })
    );
    expect(evs).toEqual([{ type: "usage", inputTokens: 12, outputTokens: 34 }]);
  });

  it("maps result error subtype to an error event", () => {
    const evs = claudeCodeAdapter.parseLine(
      line({ type: "result", subtype: "error_max_turns", errors: ["too many turns"] })
    );
    expect(evs).toHaveLength(1);
    expect(evs[0].type).toBe("error");
    if (evs[0].type === "error") expect(evs[0].message).toContain("too many turns");
  });

  it("every emitted event validates against the wire AgentEvent schema", () => {
    const samples = [
      line({ type: "assistant", message: { content: [{ type: "text", text: "x" }] } }),
      line({ type: "assistant", message: { content: [{ type: "thinking", thinking: "t" }] } }),
      line({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "i", name: "n", input: {} }] },
      }),
      line({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "i", content: "r" }] },
      }),
      line({ type: "result", subtype: "success", usage: { input_tokens: 1, output_tokens: 2 } }),
      line({ type: "result", subtype: "error_x", errors: ["e"] }),
    ];
    for (const s of samples) {
      for (const ev of claudeCodeAdapter.parseLine(s)) {
        expect(AgentEvent.safeParse(ev).success).toBe(true);
      }
    }
  });
});

describe("claudeCodeAdapter.buildSpawn", () => {
  it("builds claude spawn spec with stream-json and workspace cwd", () => {
    const spec = claudeCodeAdapter.buildSpawn("do a thing", { workspace: "/ws/proj" });
    expect(spec.cmd).toBe(process.env.CLAUDE_CLI_PATH || "claude");
    expect(spec.cwd).toBe("/ws/proj");
    expect(spec.args).toContain("-p");
    expect(spec.args).toContain("do a thing");
    expect(spec.args).toContain("--output-format");
    expect(spec.args).toContain("stream-json");
    expect(spec.args).not.toContain("--append-system-prompt");
  });

  it("strips ANTHROPIC API key env vars (claude CLI uses its own OAuth)", () => {
    const spec = claudeCodeAdapter.buildSpawn("x", { workspace: "/ws" });
    expect(spec.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(spec.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("appends project system prompt when customPrompt is provided", () => {
    const spec = claudeCodeAdapter.buildSpawn("x", { workspace: "/ws", customPrompt: "use tabs" });
    const i = spec.args.indexOf("--append-system-prompt");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(spec.args[i + 1]).toContain("use tabs");
  });

  it("declares id and resume support", () => {
    expect(claudeCodeAdapter.id).toBe("claude-code");
    expect(claudeCodeAdapter.supportsResume).toBe(true);
  });
});
