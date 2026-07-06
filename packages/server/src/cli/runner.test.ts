import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { AgentEventType } from "@pocket-code/wire";
import { runCliAgent } from "./runner.js";
import { claudeCodeAdapter } from "./claudeCode.js";

/** 造一个最小的 fake ChildProcess:可推送 stdout 行、触发 close。 */
function makeFakeProc() {
  const proc: any = new EventEmitter();
  proc.pid = 4242;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { end: vi.fn() };
  proc.kill = vi.fn();
  proc.pushLine = (obj: unknown) => proc.stdout.emit("data", Buffer.from(JSON.stringify(obj) + "\n"));
  proc.finish = (code = 0) => proc.emit("close", code);
  return proc;
}

const ctx = { workspace: "/ws" };

describe("runCliAgent", () => {
  it("spawns via adapter.buildSpawn, ends stdin, streams AgentEvents, emits done, returns text", async () => {
    const proc = makeFakeProc();
    const spawnFn = vi.fn().mockReturnValue(proc);
    const events: AgentEventType[] = [];

    const p = runCliAgent(claudeCodeAdapter, "hi", ctx, (e) => events.push(e), undefined, spawnFn);

    // spawn 调用了 claude,且关了 stdin
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(spawnFn.mock.calls[0][0]).toBe(process.env.CLAUDE_CLI_PATH || "claude");
    expect(proc.stdin.end).toHaveBeenCalled();

    proc.pushLine({ type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } });
    proc.pushLine({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "a" } }] },
    });
    proc.pushLine({ type: "result", subtype: "success", usage: { input_tokens: 1, output_tokens: 2 } });
    proc.finish(0);

    const text = await p;

    const types = events.map((e) => e.type);
    expect(types).toContain("text-delta");
    expect(types).toContain("tool-call");
    expect(types).toContain("usage");
    expect(types[types.length - 1]).toBe("done"); // 末事件必为 done
    expect(text).toBe("Hello"); // 累计 text-delta
  });

  it("handles a line split across two stdout chunks", async () => {
    const proc = makeFakeProc();
    const events: AgentEventType[] = [];
    const p = runCliAgent(claudeCodeAdapter, "hi", ctx, (e) => events.push(e), undefined, () => proc);
    const full = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "split" }] } });
    proc.stdout.emit("data", Buffer.from(full.slice(0, 10)));
    proc.stdout.emit("data", Buffer.from(full.slice(10) + "\n"));
    proc.finish(0);
    await p;
    expect(events.find((e) => e.type === "text-delta")).toEqual({ type: "text-delta", text: "split" });
  });

  it("emits a single error when process closes non-zero with no output", async () => {
    const proc = makeFakeProc();
    const events: AgentEventType[] = [];
    const p = runCliAgent(claudeCodeAdapter, "hi", ctx, (e) => events.push(e), undefined, () => proc);
    proc.finish(1);
    await p;
    expect(events.filter((e) => e.type === "error")).toHaveLength(1);
    expect(events[events.length - 1].type).toBe("done");
  });

  it("does NOT emit error on non-zero exit when output was produced", async () => {
    const proc = makeFakeProc();
    const events: AgentEventType[] = [];
    const p = runCliAgent(claudeCodeAdapter, "hi", ctx, (e) => events.push(e), undefined, () => proc);
    proc.pushLine({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } });
    proc.finish(1);
    await p;
    expect(events.filter((e) => e.type === "error")).toHaveLength(0);
  });

  it("kills the process tree when the abort signal fires", async () => {
    const proc = makeFakeProc();
    proc.pid = undefined; // 无 pid → 回退到 proc.kill,使终止可被 mock 观测
    const ac = new AbortController();
    const events: AgentEventType[] = [];
    const p = runCliAgent(claudeCodeAdapter, "hi", ctx, (e) => events.push(e), ac.signal, () => proc);
    ac.abort();
    proc.finish(0);
    await p;
    expect(proc.kill).toHaveBeenCalled(); // 进程被终止(pid 路径或回退到 proc.kill)
  });
});

describe("runCliAgent parser selection", () => {
  it("prefers createParser and creates a fresh parser per run (stateful adapters)", async () => {
    // 有状态适配器:每行输出一个递增序号事件;两次运行序号都应从 1 开始
    const statefulAdapter = {
      id: "gemini-cli" as const,
      supportsResume: false,
      buildSpawn: () => ({ cmd: "x", args: [], env: {}, cwd: "/" }),
      createParser: () => {
        let n = 0;
        return (_line: string) => [{ type: "text-delta" as const, text: `#${++n}` }];
      },
    };
    for (const run of [1, 2]) {
      const proc = makeFakeProc();
      const events: any[] = [];
      const p = runCliAgent(statefulAdapter as any, "hi", ctx, (e) => events.push(e), undefined, () => proc);
      proc.pushLine({ a: 1 });
      proc.pushLine({ a: 2 });
      proc.finish(0);
      await p;
      expect(events.filter((e) => e.type === "text-delta").map((e) => e.text)).toEqual(["#1", "#2"]);
    }
  });

  it("throws a clear error when adapter has neither parseLine nor createParser", async () => {
    const badAdapter = {
      id: "codex" as const,
      supportsResume: false,
      buildSpawn: () => ({ cmd: "x", args: [], env: {}, cwd: "/" }),
    };
    await expect(
      runCliAgent(badAdapter as any, "hi", ctx, () => {}, undefined, () => makeFakeProc())
    ).rejects.toThrow(/parseLine|createParser/);
  });
});
