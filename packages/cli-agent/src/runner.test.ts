import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { CliEvent } from "./types.js";
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
    const events: CliEvent[] = [];

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

    const { fullText } = await p;

    const types = events.map((e) => e.type);
    expect(types).toContain("text-delta");
    expect(types).toContain("tool-call");
    expect(types).toContain("usage");
    expect(types[types.length - 1]).toBe("done"); // 末事件必为 done
    expect(fullText).toBe("Hello"); // 累计 text-delta
  });

  it("handles a line split across two stdout chunks", async () => {
    const proc = makeFakeProc();
    const events: CliEvent[] = [];
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
    const events: CliEvent[] = [];
    const p = runCliAgent(claudeCodeAdapter, "hi", ctx, (e) => events.push(e), undefined, () => proc);
    proc.finish(1);
    await p;
    expect(events.filter((e) => e.type === "error")).toHaveLength(1);
    expect(events[events.length - 1].type).toBe("done");
  });

  it("does NOT emit error on non-zero exit when output was produced", async () => {
    const proc = makeFakeProc();
    const events: CliEvent[] = [];
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
    const events: CliEvent[] = [];
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

describe("runCliAgent 返回对象 + session_id 采集", () => {
  it("返回 { fullText, cliSessionId }(首次命中即记住)", async () => {
    const proc = makeFakeProc();
    const adapter = {
      id: "claude-code" as const,
      supportsResume: true,
      buildSpawn: () => ({ cmd: "claude", args: [], env: {} as any, cwd: "/ws" }),
      parseLine: (l: string) => {
        try {
          const m = JSON.parse(l);
          return m.text ? [{ type: "text-delta" as const, text: m.text }] : [];
        } catch {
          return [];
        }
      },
      extractSessionId: (l: string) => {
        try {
          const m = JSON.parse(l);
          return m.session_id;
        } catch {
          return undefined;
        }
      },
    };
    const events: CliEvent[] = [];
    const p = runCliAgent(adapter as any, "hi", ctx, (e) => events.push(e), undefined, () => proc);

    proc.pushLine({ session_id: "sess_123" });
    proc.pushLine({ text: "hello" });
    proc.finish(0);

    const result = await p;
    expect(result.fullText).toBe("hello");
    expect(result.cliSessionId).toBe("sess_123");
  });

  it("adapter 无 extractSessionId 时 cliSessionId 为 undefined", async () => {
    const proc = makeFakeProc();
    const events: CliEvent[] = [];
    const p = runCliAgent(claudeCodeAdapter, "hi", ctx, (e) => events.push(e), undefined, () => proc);
    proc.pushLine({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } });
    proc.finish(0);
    const result = await p;
    expect(result.cliSessionId).toBeUndefined();
  });
});

describe("runCliAgent 空闲超时", () => {
  it("120s 无输出 → kill + error 事件,且不重复 resolve(由 close 收尾)", async () => {
    vi.useFakeTimers();
    try {
      const proc = makeFakeProc();
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
      const events: CliEvent[] = [];
      const p = runCliAgent(claudeCodeAdapter, "hi", ctx, (e) => events.push(e), undefined, () => proc);

      await vi.advanceTimersByTimeAsync(120001);

      // 空闲超时应已触发 kill(经 killProcessTree),但尚未 resolve —— close 事件才收尾。
      expect(killSpy).toHaveBeenCalled();
      expect(events.some((e) => e.type === "error" && e.message.includes("120s 无输出"))).toBe(true);

      // 模拟 kill 引发的 close 事件,负责真正 resolve。
      proc.finish(null as any);
      const result = await p;
      expect(result.fullText).toBe("");
      expect(events[events.length - 1].type).toBe("done");
    } finally {
      vi.useRealTimers();
    }
  });

  it("有输出活动时重置计时器,不会误触发空闲超时", async () => {
    vi.useFakeTimers();
    try {
      const proc = makeFakeProc();
      const events: CliEvent[] = [];
      const p = runCliAgent(claudeCodeAdapter, "hi", ctx, (e) => events.push(e), undefined, () => proc);

      // 每次在超时前产生输出,重置计时器。
      await vi.advanceTimersByTimeAsync(100000);
      proc.pushLine({ type: "assistant", message: { content: [{ type: "text", text: "still going" }] } });
      await vi.advanceTimersByTimeAsync(100000);
      proc.pushLine({ type: "assistant", message: { content: [{ type: "text", text: "more" }] } });
      await vi.advanceTimersByTimeAsync(100000);

      expect(events.some((e) => e.type === "error")).toBe(false);

      proc.finish(0);
      const result = await p;
      expect(result.fullText).toBe("still goingmore");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("runCliAgent stderr 尾附错误", () => {
  it("异常退出且无输出时,错误 message 附上 stderr 尾部", async () => {
    const proc = makeFakeProc();
    const events: CliEvent[] = [];
    const p = runCliAgent(claudeCodeAdapter, "hi", ctx, (e) => events.push(e), undefined, () => proc);

    proc.stderr.emit("data", Buffer.from("Error: something broke\n"));
    proc.stderr.emit("data", Buffer.from("at somewhere.js:10\n"));
    proc.finish(1);
    await p;

    const errorEvents = events.filter((e) => e.type === "error") as Array<{ type: "error"; message: string }>;
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].message).toContain("进程异常退出");
    expect(errorEvents[0].message).toContain("Error: something broke");
    expect(errorEvents[0].message).toContain("at somewhere.js:10");
    // 多 chunk 的 stderr 尾必须保留 chunk 间换行(不挤成 run-on line)
    expect(errorEvents[0].message).toContain("Error: something broke\nat somewhere.js:10");
  });

  it("正常退出(有输出)时不附 stderr 尾", async () => {
    const proc = makeFakeProc();
    const events: CliEvent[] = [];
    const p = runCliAgent(claudeCodeAdapter, "hi", ctx, (e) => events.push(e), undefined, () => proc);

    proc.stderr.emit("data", Buffer.from("just a warning\n"));
    proc.pushLine({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } });
    proc.finish(0);
    await p;

    expect(events.filter((e) => e.type === "error")).toHaveLength(0);
  });
});
