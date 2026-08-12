// ── P16 集成:goal-create/goal-control 分发(spec C16-1/3/4)──
// runGoalDriver mock 为 spy(driver 行为已在 driver.test 覆盖);
// createSession 返回可控对象以便断言 session.goal 变迁与 abort 联动。

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ServerOutboundType } from "@pocket-code/wire";
import { _resetStreams } from "./eventBuffer.js";
import { createGoal } from "./goal/types.js";
import type { GoalState } from "./goal/types.js";

interface FakeSession {
  sessionId: string;
  userId: string;
  projectId: string;
  workspace: string;
  messages: unknown[];
  modelKey: string;
  lastActivity: number;
  goal?: GoalState;
  currentAbort?: AbortController;
}

let sessionObjs: Map<string, FakeSession>;

vi.mock("./agent.js", () => ({
  createSession: vi.fn(async (sessionId: string, userId: string, projectId = "") => {
    const s: FakeSession = {
      sessionId, userId, projectId,
      workspace: "/tmp/ws", messages: [], modelKey: "deepseek-v4-flash", lastActivity: Date.now(),
    };
    sessionObjs.set(sessionId, s);
    return s;
  }),
  runAgent: vi.fn(async () => undefined),
}));

const runGoalDriverMock = vi.fn(async (..._args: unknown[]) => {});
vi.mock("./goal/driver.js", () => ({
  runGoalDriver: (...args: unknown[]) => runGoalDriverMock(...args),
}));

const saveSessionGoalMock = vi.fn();
vi.mock("./db.js", () => ({
  initDb: vi.fn(async () => {}),
  listUserSessions: vi.fn(() => []),
  deleteSession: vi.fn(() => true),
  saveSessionGoal: (...args: unknown[]) => saveSessionGoalMock(...args),
}));

vi.mock("./docker.js", () => ({ isDockerEnabled: () => false, getContainer: vi.fn() }));
vi.mock("./resourceLimits.js", () => ({
  checkQuota: () => ({ allowed: true }),
  incrementUsage: vi.fn(),
  getUserQuota: vi.fn(() => ({ userId: "u1", tier: "free", limits: {}, usage: {} })),
}));
vi.mock("./gitCredentials.js", () => ({
  cleanupLegacyWorkspaceCredentials: vi.fn(async () => 0),
  migrateLegacyGitCredentials: vi.fn(async () => []),
}));
vi.mock("./nodeBackend.js", () => ({ createNodeBackend: vi.fn(() => ({})) }));
vi.mock("./sync/syncHandler.js", () => ({ handleSyncPull: vi.fn(), handleSyncFile: vi.fn() }));

const { createMessageHandler } = await import("./messageHandler.js");

function makeHandler() {
  const sent: ServerOutboundType[] = [];
  const handler = createMessageHandler((data) => sent.push(data), {
    preAuth: { userId: "u1", deviceId: "d1" } as any,
  });
  return { sent, handler };
}

const msg = (obj: Record<string, unknown>) => JSON.stringify(obj);

beforeEach(() => {
  _resetStreams();
  sessionObjs = new Map();
  runGoalDriverMock.mockClear();
  saveSessionGoalMock.mockClear();
});

describe("messageHandler — P16 goal 分发", () => {
  it("goal-create: creates goal, publishes goal-updated(active) with seq, starts driver", async () => {
    const { sent, handler } = makeHandler();
    await handler.onMessage(msg({ type: "init", sessionId: "g1" }));
    await handler.onMessage(msg({ type: "goal-create", content: "清零 lint 错误", maxTurns: 30 }));

    const session = sessionObjs.get("g1")!;
    expect(session.goal).toMatchObject({ goal: "清零 lint 错误", status: "active" });
    expect(session.goal!.budgets.maxTurns).toBe(30);
    const ev = sent.find((m: any) => m.type === "goal-updated") as any;
    expect(ev).toMatchObject({ status: "active", change: "lifecycle", goal: "清零 lint 错误" });
    expect(typeof ev.seq).toBe("number"); // C16-3:goal 事件计入 seq 流
    expect(saveSessionGoalMock).toHaveBeenCalledWith("g1", expect.any(String));
    expect(runGoalDriverMock).toHaveBeenCalledTimes(1);
  });

  it("duplicate goal-create without replace → error, no second driver; replace:true recreates", async () => {
    const { sent, handler } = makeHandler();
    await handler.onMessage(msg({ type: "init", sessionId: "g2" }));
    await handler.onMessage(msg({ type: "goal-create", content: "目标A" }));
    await handler.onMessage(msg({ type: "goal-create", content: "目标B" }));
    expect((sent as any[]).some((m) => m.type === "error" && String(m.error).includes("replace"))).toBe(true);
    expect(sessionObjs.get("g2")!.goal!.goal).toBe("目标A");
    expect(runGoalDriverMock).toHaveBeenCalledTimes(1);

    await handler.onMessage(msg({ type: "goal-create", content: "目标B", replace: true }));
    expect(sessionObjs.get("g2")!.goal!.goal).toBe("目标B");
    expect(runGoalDriverMock).toHaveBeenCalledTimes(2);
  });

  it("goal-control pause: active → paused + persist + abort current turn (C16-1)", async () => {
    const { handler } = makeHandler();
    await handler.onMessage(msg({ type: "init", sessionId: "g3" }));
    const session = sessionObjs.get("g3")!;
    session.goal = createGoal("目标");
    const abort = new AbortController();
    session.currentAbort = abort;

    await handler.onMessage(msg({ type: "goal-control", action: "pause" }));
    expect(session.goal!.status).toBe("paused");
    expect(session.goal!.stopReason).toBe("用户暂停");
    expect(abort.signal.aborted).toBe(true);
    expect(saveSessionGoalMock).toHaveBeenCalled();
  });

  it("goal-control resume: paused → active, stopReason cleared, driver restarted (C16-5)", async () => {
    const { sent, handler } = makeHandler();
    await handler.onMessage(msg({ type: "init", sessionId: "g4" }));
    const session = sessionObjs.get("g4")!;
    session.goal = createGoal("目标");
    session.goal.status = "blocked";
    session.goal.stopReason = "缺凭证";

    await handler.onMessage(msg({ type: "goal-control", action: "resume" }));
    expect(session.goal!.status).toBe("active");
    expect(session.goal!.stopReason).toBeUndefined();
    expect((sent as any[]).some((m) => m.type === "goal-updated" && m.status === "active")).toBe(true);
    expect(runGoalDriverMock).toHaveBeenCalledTimes(1);
  });

  it("goal-control cancel: cleared event, goal removed, persist(null)", async () => {
    const { sent, handler } = makeHandler();
    await handler.onMessage(msg({ type: "init", sessionId: "g5" }));
    const session = sessionObjs.get("g5")!;
    session.goal = createGoal("目标");
    const abort = new AbortController();
    session.currentAbort = abort;

    await handler.onMessage(msg({ type: "goal-control", action: "cancel" }));
    expect(session.goal).toBeUndefined();
    expect(abort.signal.aborted).toBe(true);
    expect((sent as any[]).some((m) => m.type === "goal-updated" && m.change === "cleared")).toBe(true);
    expect(saveSessionGoalMock).toHaveBeenLastCalledWith("g5", null);
  });
});
