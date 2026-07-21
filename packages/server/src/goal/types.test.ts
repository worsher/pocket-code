import { describe, it, expect } from "vitest";
import { createGoal, makeUpdateGoalStatusTool, goalUpdatedEvent, clearedEvent } from "./types.js";

describe("makeUpdateGoalStatusTool (C16-1/7)", () => {
  it("marks status/reason/updatedAt; prompts model to summarize", async () => {
    const session = { goal: createGoal("清零 lint 错误") };
    const before = session.goal.updatedAt;
    const tool = makeUpdateGoalStatusTool(session);
    expect(tool.schema.name).toBe("updateGoalStatus");
    const r = (await tool.execute({} as any, { status: "blocked", reason: "缺凭证" })) as any;
    expect(r.success).toBe(true);
    expect(session.goal.status).toBe("blocked");
    expect(session.goal.stopReason).toBe("缺凭证");
    expect(session.goal.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it("rejects unknown status; errors when no goal", async () => {
    const session = { goal: createGoal("x") };
    const tool = makeUpdateGoalStatusTool(session);
    expect(((await tool.execute({} as any, { status: "done" })) as any).success).toBe(false);
    expect(session.goal.status).toBe("active"); // 未被改动
    const empty = makeUpdateGoalStatusTool({});
    expect(((await empty.execute({} as any, { status: "complete" })) as any).success).toBe(false);
  });
});

describe("event builders", () => {
  it("goalUpdatedEvent / clearedEvent shapes match wire", () => {
    const g = createGoal("目标", "标准", 30);
    g.stats.turns = 3;
    const ev = goalUpdatedEvent(g, "lifecycle") as any;
    expect(ev).toMatchObject({ type: "goal-updated", status: "active", change: "lifecycle", goal: "目标", maxTurns: 30 });
    expect(ev.stats.turns).toBe(3);
    const cleared = clearedEvent(g.stats) as any;
    expect(cleared).toMatchObject({ type: "goal-updated", change: "cleared" });
    expect(cleared.goal).toBeUndefined();
  });
});
