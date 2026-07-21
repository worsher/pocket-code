// ── P16 driver 单测(spec C16-2/4/5,D-P16-4)──────────────
// runAgent 以依赖注入 mock:脚本化返回 outcome 序列,可在实现里改 session.goal
// 模拟 updateGoalStatus 工具调用;persistGoal/publish 用 vi.fn 断言。

import { describe, it, expect, vi } from "vitest";
import { runGoalDriver, type GoalDriverDeps, type TurnOutcome } from "./driver.js";
import { createGoal } from "./types.js";
import type { AgentSession } from "../agent.js";

function mkSession(goalContent = "清零 lint 错误", maxTurns = 20): AgentSession {
  return {
    sessionId: "s1",
    userId: "u1",
    projectId: "",
    workspace: "/tmp/ws",
    messages: [],
    modelKey: "deepseek-v4-flash",
    lastActivity: Date.now(),
    goal: createGoal(goalContent, undefined, maxTurns),
  } as AgentSession;
}

/** 每轮按脚本执行:返回 outcome,并可对 session 施加副作用(模拟工具/控制)。 */
type TurnScript = {
  outcome: TurnOutcome | undefined;
  effect?: (session: AgentSession) => void;
};

function mkDeps(script: TurnScript[]) {
  let i = 0;
  const contents: string[] = [];
  const runAgent = vi.fn(async (session: AgentSession, content: string) => {
    contents.push(content);
    const step = script[Math.min(i, script.length - 1)];
    i++;
    step.effect?.(session);
    return step.outcome;
  });
  const persistGoal = vi.fn();
  const publish = vi.fn();
  const deps: GoalDriverDeps = { runAgent: runAgent as any, persistGoal, publish };
  return { deps, runAgent, persistGoal, publish, contents };
}

const ok = (stopReason: TurnOutcome["stopReason"]): TurnOutcome => ({
  stopReason,
  usage: { inputTokens: 10, outputTokens: 5 },
});

/** 模拟"本轮有实际进展":刷新 updatedAt(防空转判据依赖它)。 */
const progress = (s: AgentSession) => {
  s.goal!.updatedAt = Date.now() + Math.random();
};

describe("runGoalDriver", () => {
  it("① complete: tool marks complete → completion event, goal cleared, persist(null) (C16-4)", async () => {
    const session = mkSession();
    const { deps, runAgent, persistGoal, publish } = mkDeps([
      { outcome: ok("end_turn"), effect: progress },
      { outcome: ok("end_turn"), effect: (s) => { s.goal!.status = "complete"; s.goal!.updatedAt = Date.now() + 1; } },
    ]);
    await runGoalDriver(session, deps);
    expect(runAgent).toHaveBeenCalledTimes(2);
    const completion = publish.mock.calls.map((c) => c[0]).find((e: any) => e.change === "completion");
    expect(completion).toMatchObject({ type: "goal-updated", status: "complete" });
    expect(session.goal).toBeUndefined();
    expect(persistGoal).toHaveBeenLastCalledWith("s1", null);
  });

  it("② max_steps keeps running (auto-continue, C16-2 × P12)", async () => {
    const session = mkSession();
    const { deps, runAgent } = mkDeps([
      { outcome: ok("max_steps") },
      { outcome: ok("max_steps") },
      { outcome: ok("max_steps") },
      { outcome: ok("end_turn"), effect: (s) => { s.goal!.status = "complete"; } },
    ]);
    await runGoalDriver(session, deps);
    expect(runAgent).toHaveBeenCalledTimes(4);
  });

  it("③ error → paused; aborted → paused; exactly one lifecycle event each (C16-5)", async () => {
    for (const reason of ["error", "aborted"] as const) {
      const session = mkSession();
      const { deps, publish } = mkDeps([{ outcome: ok(reason) }]);
      await runGoalDriver(session, deps);
      expect(session.goal!.status).toBe("paused");
      const lifecycles = publish.mock.calls.map((c) => c[0]).filter((e: any) => e.type === "goal-updated");
      expect(lifecycles.length).toBe(1);
      expect(lifecycles[0]).toMatchObject({ status: "paused", change: "lifecycle" });
    }
  });

  it("④ budget: maxTurns=2 → blocked(预算) before 3rd turn, runAgent exactly twice (C16-2)", async () => {
    const session = mkSession("目标", 2);
    const { deps, runAgent, publish } = mkDeps([
      { outcome: ok("end_turn"), effect: progress },
      { outcome: ok("end_turn"), effect: progress },
    ]);
    await runGoalDriver(session, deps);
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(session.goal!.status).toBe("blocked");
    expect(session.goal!.stopReason).toContain("预算");
    expect(publish.mock.calls.at(-1)![0]).toMatchObject({ status: "blocked", change: "lifecycle" });
  });

  it("⑤ anti-stall: 3 consecutive idle end_turn turns → blocked (D-P16-4)", async () => {
    const session = mkSession();
    const { deps, runAgent } = mkDeps([
      { outcome: ok("end_turn") }, // 无 effect:updatedAt 不变 = 未调工具
      { outcome: ok("end_turn") },
      { outcome: ok("end_turn") },
    ]);
    await runGoalDriver(session, deps);
    expect(runAgent).toHaveBeenCalledTimes(3);
    expect(session.goal!.status).toBe("blocked");
    expect(session.goal!.stopReason).toContain("无进展");
  });

  it("⑥ stats accumulate; kickoff only on turn 1, continuation afterwards", async () => {
    const session = mkSession();
    const { deps, contents } = mkDeps([
      { outcome: ok("max_steps") },
      { outcome: ok("end_turn"), effect: (s) => { s.goal!.status = "complete"; } },
    ]);
    await runGoalDriver(session, deps);
    expect(contents[0].startsWith("[goal]")).toBe(true);
    expect(contents[0]).toContain("清零 lint 错误");
    expect(contents[1].startsWith("[goal continuation]")).toBe(true);
    // stats:2 轮、tokens 累加(complete 清除前的快照经 completion 事件可见)
  });

  it("⑦ cancel mid-turn (goal removed) → silent exit, no extra events", async () => {
    const session = mkSession();
    const { deps, publish } = mkDeps([
      { outcome: ok("end_turn"), effect: progress },
      { outcome: ok("aborted"), effect: (s) => { s.goal = undefined; } },
    ]);
    await runGoalDriver(session, deps);
    expect(session.goal).toBeUndefined();
    expect(publish.mock.calls.map((c) => c[0]).filter((e: any) => e.type === "goal-updated").length).toBe(0);
  });

  it("⑧ tool marks blocked → lifecycle event with stopReason, driver stops", async () => {
    const session = mkSession();
    const { deps, runAgent, publish } = mkDeps([
      { outcome: ok("end_turn"), effect: (s) => { s.goal!.status = "blocked"; s.goal!.stopReason = "需要 npm 私仓凭证"; } },
    ]);
    await runGoalDriver(session, deps);
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls.at(-1)![0]).toMatchObject({
      type: "goal-updated", status: "blocked", change: "lifecycle", stopReason: "需要 npm 私仓凭证",
    });
  });

  it("⑨ turns increment and completion event carries stats", async () => {
    const session = mkSession();
    const { deps, publish } = mkDeps([
      { outcome: ok("max_steps") },
      { outcome: ok("max_steps") },
      { outcome: ok("end_turn"), effect: (s) => { s.goal!.status = "complete"; } },
    ]);
    await runGoalDriver(session, deps);
    const completion = publish.mock.calls.map((c) => c[0]).find((e: any) => e.change === "completion");
    expect(completion.stats).toEqual({ turns: 3, inputTokens: 30, outputTokens: 15 });
  });
});
