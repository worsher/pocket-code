// ── P16 集成:goal-create/goal-control 分发(spec C16-1/3/4)──
// runGoalDriver mock 为 spy(driver 行为已在 driver.test 覆盖);
// createSession 返回可控对象以便断言 session.goal 变迁与 abort 联动。

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ServerOutboundType } from "@pocket-code/wire";
import { getSessionStream, _resetStreams } from "./eventBuffer.js";
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
  currentAbortOwner?: "message" | "goal";
}

let sessionObjs: Map<string, FakeSession>;

const createSessionMock = vi.fn(async (sessionId: string, userId: string, projectId = "") => {
  const s: FakeSession = {
    sessionId,
    userId,
    projectId,
    workspace: "/tmp/ws",
    messages: [],
    modelKey: "deepseek-v4-flash",
    lastActivity: Date.now(),
  };
  sessionObjs.set(sessionId, s);
  return s;
});
const runAgentMock = vi.fn((..._args: unknown[]): Promise<void> => Promise.resolve());

vi.mock("./agent.js", () => ({
  createSession: (...args: [string, string, string?]) => createSessionMock(...args),
  runAgent: (...args: unknown[]) => runAgentMock(...args),
}));

const runGoalDriverMock = vi.fn(async (..._args: unknown[]) => {});
vi.mock("./goal/driver.js", () => ({
  runGoalDriver: (...args: unknown[]) => runGoalDriverMock(...args),
}));

const saveSessionGoalMock = vi.fn();
vi.mock("./db.js", () => ({
  initDb: vi.fn(async () => {}),
  claimTurnJournal: vi.fn(() => ({ kind: "claimed", claimToken: "goal-test-claim" })),
  completeTurnJournal: vi.fn(() => true),
  listUserSessions: vi.fn(() => []),
  listWorkspaceProjects: vi.fn(() => []),
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
vi.mock("./workspaceFeatureFlags.js", () => ({
  getServerWorkspaceFeatureFlags: () => ({
    catalogV2: false,
    resolverV2: false,
    protocolV2: true,
    importV2: false,
    syncV2: false,
  }),
}));

const { cleanupStaleSessions, createMessageHandler } = await import("./messageHandler.js");

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
  createSessionMock.mockClear();
  runAgentMock.mockReset();
  runAgentMock.mockImplementation((..._args: unknown[]): Promise<void> => Promise.resolve());
  runGoalDriverMock.mockReset();
  runGoalDriverMock.mockImplementation(async (..._args: unknown[]) => undefined);
  saveSessionGoalMock.mockClear();
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("messageHandler — P16 goal 分发", () => {
  it("goal-create: creates goal, publishes goal-updated(active) with seq, starts driver", async () => {
    const { sent, handler } = makeHandler();
    await handler.onMessage(msg({ type: "init", sessionId: "g1" }));
    await handler.onMessage(
      msg({ type: "goal-create", turnId: "goal-turn-1", content: "清零 lint 错误", maxTurns: 30 })
    );

    const session = sessionObjs.get("g1")!;
    expect(session.goal).toMatchObject({ goal: "清零 lint 错误", status: "active" });
    expect(session.goal!.budgets.maxTurns).toBe(30);
    const ev = sent.find((m: any) => m.type === "goal-updated") as any;
    expect(ev).toMatchObject({
      status: "active",
      change: "lifecycle",
      goal: "清零 lint 错误",
      turnId: "goal-turn-1",
    });
    expect(typeof ev.seq).toBe("number"); // C16-3:goal 事件计入 seq 流
    expect(saveSessionGoalMock).toHaveBeenCalledWith(
      "g1",
      expect.stringContaining('"transportTurnId":"goal-turn-1"'),
      expect.objectContaining({ userId: "u1", projectId: "", messages: [] })
    );
    expect(runGoalDriverMock).toHaveBeenCalledTimes(1);
  });

  it("duplicate goal-create without replace → error, no second driver; replace:true recreates", async () => {
    const { sent, handler } = makeHandler();
    await handler.onMessage(msg({ type: "init", sessionId: "g2" }));
    await handler.onMessage(msg({ type: "goal-create", content: "目标A" }));
    await handler.onMessage(msg({ type: "goal-create", content: "目标B" }));
    expect(
      (sent as any[]).some((m) => m.type === "error" && String(m.error).includes("replace"))
    ).toBe(true);
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
    session.currentAbortOwner = "goal";

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

    await handler.onMessage(
      msg({ type: "goal-control", action: "resume", turnId: "goal-resume-turn" })
    );
    expect(session.goal!.status).toBe("active");
    expect(session.goal!.stopReason).toBeUndefined();
    expect(session.goal!.transportTurnId).toBe("goal-resume-turn");
    expect(
      (sent as any[]).some(
        (m) => m.type === "goal-updated" && m.status === "active" && m.turnId === "goal-resume-turn"
      )
    ).toBe(true);
    expect(runGoalDriverMock).toHaveBeenCalledTimes(1);
  });

  it("goal-control resume returns a correlated terminal error when no goal can resume", async () => {
    const { sent, handler } = makeHandler();
    await handler.onMessage(msg({ type: "init", sessionId: "g4-stale" }));

    await handler.onMessage(
      msg({ type: "goal-control", action: "resume", turnId: "turn-stale-resume" })
    );

    expect(sent.slice(-2)).toMatchObject([
      {
        type: "error",
        code: "goal-resume-unavailable",
        turnId: "turn-stale-resume",
      },
      { type: "done", stopReason: "error", turnId: "turn-stale-resume" },
    ]);
    expect(runGoalDriverMock).not.toHaveBeenCalled();
  });

  it("goal-control cancel: cleared event, goal removed, persist(null)", async () => {
    const { sent, handler } = makeHandler();
    await handler.onMessage(msg({ type: "init", sessionId: "g5" }));
    const session = sessionObjs.get("g5")!;
    session.goal = createGoal("目标", undefined, undefined, "goal-cancel-turn");
    const abort = new AbortController();
    session.currentAbort = abort;
    session.currentAbortOwner = "goal";

    await handler.onMessage(msg({ type: "goal-control", action: "cancel" }));
    expect(session.goal).toBeUndefined();
    expect(abort.signal.aborted).toBe(true);
    expect((sent as any[]).some((m) => m.type === "goal-updated" && m.change === "cleared")).toBe(
      true
    );
    expect(
      (sent as any[]).find((m) => m.type === "goal-updated" && m.change === "cleared")
    ).toMatchObject({ turnId: "goal-cancel-turn" });
    expect(saveSessionGoalMock).toHaveBeenLastCalledWith("g5", null);
  });

  it("re-emits a persisted paused goal before session-ready on reconnect", async () => {
    const original = makeHandler();
    await original.handler.onMessage(
      msg({
        type: "init",
        sessionId: "g-restored-paused",
        workspaceProtocolVersion: 2,
      })
    );
    const session = sessionObjs.get("g-restored-paused")!;
    session.goal = createGoal("恢复目标", undefined, 20, "goal-restored-turn");
    session.goal.status = "paused";
    session.goal.stopReason = "进程重启,已暂停";
    const goalStream = getSessionStream("g-restored-paused");
    goalStream.publish({ type: "text-delta", text: "buffered-before-recovery" });

    const replacement = makeHandler();
    await replacement.handler.onMessage(
      msg({
        type: "init",
        sessionId: "g-restored-paused",
        workspaceProtocolVersion: 2,
        eventEpoch: goalStream.epoch,
        lastSeq: 0,
      })
    );

    expect(replacement.sent.map((event) => event.type)).toEqual([
      "session",
      "text-delta",
      "goal-updated",
      "session-ready",
    ]);
    expect(replacement.sent[2]).toMatchObject({
      type: "goal-updated",
      status: "paused",
      change: "lifecycle",
      turnId: "goal-restored-turn",
    });
    expect(replacement.sent[3]).toMatchObject({ currentSeq: 2 });
  });

  it("reconciles a retained active goal turn before session-ready", async () => {
    const original = makeHandler();
    await original.handler.onMessage(msg({ type: "init", sessionId: "g-retained-active" }));
    const session = sessionObjs.get("g-retained-active")!;
    session.goal = createGoal("仍在运行", undefined, 20, "goal-active-turn");

    const replacement = makeHandler();
    await replacement.handler.onMessage(
      msg({
        type: "init",
        sessionId: "g-retained-active",
        activeTurnId: "goal-active-turn",
        activeTurnKind: "goal",
        workspaceProtocolVersion: 2,
      })
    );

    const lifecycle = replacement.sent.find(
      (event: any) => event.type === "goal-updated" && event.turnId === "goal-active-turn"
    );
    expect(lifecycle).toMatchObject({
      status: "active",
      change: "lifecycle",
      goal: "仍在运行",
    });
    expect(replacement.sent.at(-1)?.type).toBe("session-ready");
  });

  it("terminates a retained goal turn that never reached the authority", async () => {
    const { sent, handler } = makeHandler();
    await handler.onMessage(
      msg({
        type: "init",
        sessionId: "g-missing-active",
        activeTurnId: "goal-missing-turn",
        activeTurnKind: "goal",
        workspaceProtocolVersion: 2,
      })
    );

    const recoveryFrames = sent.filter(
      (event: any) => event.turnId === "goal-missing-turn"
    ) as any[];
    expect(recoveryFrames).toMatchObject([
      { type: "error", code: "goal-recovery-unavailable" },
      { type: "goal-updated", change: "cleared" },
      { type: "done", stopReason: "error" },
    ]);
    expect(sent.at(-1)?.type).toBe("session-ready");
  });

  it("terminates a phantom resume without clearing the real parked goal", async () => {
    const original = makeHandler();
    await original.handler.onMessage(msg({ type: "init", sessionId: "g-phantom-resume" }));
    const session = sessionObjs.get("g-phantom-resume")!;
    session.goal = createGoal("真实暂停目标", undefined, 20, "goal-real-paused");
    session.goal.status = "paused";
    session.goal.stopReason = "等待用户继续";

    const replacement = makeHandler();
    await replacement.handler.onMessage(
      msg({
        type: "init",
        sessionId: "g-phantom-resume",
        activeTurnId: "goal-phantom-resume",
        activeTurnKind: "goal",
        workspaceProtocolVersion: 2,
      })
    );

    expect(
      replacement.sent.filter((event: any) => event.turnId === "goal-phantom-resume")
    ).toMatchObject([
      { type: "error", code: "goal-recovery-unavailable" },
      { type: "done", stopReason: "error" },
    ]);
    expect(
      replacement.sent.some(
        (event: any) => event.type === "goal-updated" && event.change === "cleared"
      )
    ).toBe(false);
    expect(
      replacement.sent.find((event: any) => event.turnId === "goal-real-paused")
    ).toMatchObject({
      type: "goal-updated",
      change: "lifecycle",
      status: "paused",
      goal: "真实暂停目标",
    });
    expect(replacement.sent.at(-1)?.type).toBe("session-ready");
  });

  it("does not report a missing goal after its completion was replayed from backlog", async () => {
    const original = makeHandler();
    await original.handler.onMessage(
      msg({
        type: "init",
        sessionId: "g-completed-offline",
        workspaceProtocolVersion: 2,
      })
    );
    const goalStream = getSessionStream("g-completed-offline");
    goalStream.publish({
      type: "goal-updated",
      status: "complete",
      change: "completion",
      goal: "断线期间完成",
      stats: { turns: 2, inputTokens: 3, outputTokens: 5 },
      turnId: "goal-completed-turn",
    });
    sessionObjs.get("g-completed-offline")!.goal = undefined;

    const replacement = makeHandler();
    await replacement.handler.onMessage(
      msg({
        type: "init",
        sessionId: "g-completed-offline",
        workspaceProtocolVersion: 2,
        activeTurnId: "goal-completed-turn",
        activeTurnKind: "goal",
        eventEpoch: goalStream.epoch,
        lastSeq: 0,
      })
    );

    expect(
      replacement.sent.filter((event: any) => event.turnId === "goal-completed-turn")
    ).toMatchObject([{ type: "goal-updated", change: "completion" }]);
    expect(
      replacement.sent.some(
        (event: any) => event.type === "error" && event.code === "goal-recovery-unavailable"
      )
    ).toBe(false);
    expect(replacement.sent.at(-1)?.type).toBe("session-ready");
  });

  it.each(["paused", "blocked"] as const)(
    "cancelling a %s goal does not abort the ordinary message that currently owns the lane",
    async (goalStatus) => {
      const { handler } = makeHandler();
      await handler.onMessage(msg({ type: "init", sessionId: `g-cancel-${goalStatus}` }));
      const session = sessionObjs.get(`g-cancel-${goalStatus}`)!;
      session.goal = createGoal("旧目标");
      session.goal.status = goalStatus;
      const messageRun = deferred();
      let messageSignal: AbortSignal | undefined;
      runAgentMock.mockImplementationOnce(async (...args: unknown[]) => {
        messageSignal = args[3] as AbortSignal;
        await messageRun.promise;
      });

      const messageTurn = handler.onMessage(msg({ type: "message", content: "当前普通消息" }));
      await vi.waitFor(() => expect(messageSignal).toBeDefined());
      expect(session.currentAbortOwner).toBe("message");

      await handler.onMessage(msg({ type: "goal-control", action: "cancel" }));
      expect(messageSignal!.aborted).toBe(false);
      expect(session.goal).toBeUndefined();

      messageRun.resolve();
      await messageTurn;
    }
  );

  it("queues goal-create behind an active message turn", async () => {
    const { handler } = makeHandler();
    await handler.onMessage(msg({ type: "init", sessionId: "g-message-first" }));
    const messageRun = deferred();
    runAgentMock.mockImplementationOnce(async () => messageRun.promise);

    const messageTurn = handler.onMessage(msg({ type: "message", content: "先处理消息" }));
    await vi.waitFor(() => expect(runAgentMock).toHaveBeenCalledTimes(1));
    const goalTurn = handler.onMessage(msg({ type: "goal-create", content: "随后创建目标" }));
    await Promise.resolve();

    expect(runGoalDriverMock).not.toHaveBeenCalled();
    expect(sessionObjs.get("g-message-first")!.goal).toBeUndefined();

    messageRun.resolve();
    await messageTurn;
    await goalTurn;
    expect(runGoalDriverMock).toHaveBeenCalledTimes(1);
  });

  it("queues a message behind the complete goal driver", async () => {
    const { handler } = makeHandler();
    await handler.onMessage(msg({ type: "init", sessionId: "g-goal-first" }));
    const goalRun = deferred();
    runGoalDriverMock.mockImplementationOnce(async () => goalRun.promise);

    const goalTurn = handler.onMessage(msg({ type: "goal-create", content: "先运行目标" }));
    await vi.waitFor(() => expect(runGoalDriverMock).toHaveBeenCalledTimes(1));
    const messageTurn = handler.onMessage(msg({ type: "message", content: "随后处理消息" }));
    await Promise.resolve();

    expect(runAgentMock).not.toHaveBeenCalled();

    goalRun.resolve();
    await goalTurn;
    await messageTurn;
    expect(runAgentMock).toHaveBeenCalledTimes(1);
  });

  it("resume re-reads the goal after waiting for the lane, so cancel wins", async () => {
    const { handler } = makeHandler();
    await handler.onMessage(msg({ type: "init", sessionId: "g-resume-reread" }));
    const session = sessionObjs.get("g-resume-reread")!;
    session.goal = createGoal("等待恢复的目标");
    session.goal.status = "blocked";
    const messageRun = deferred();
    runAgentMock.mockImplementationOnce(async () => messageRun.promise);

    const messageTurn = handler.onMessage(msg({ type: "message", content: "占用 lane" }));
    await vi.waitFor(() => expect(runAgentMock).toHaveBeenCalledTimes(1));
    const resumeTurn = handler.onMessage(msg({ type: "goal-control", action: "resume" }));
    await Promise.resolve();

    await handler.onMessage(msg({ type: "goal-control", action: "cancel" }));
    expect(session.goal).toBeUndefined();

    messageRun.resolve();
    await messageTurn;
    await resumeTurn;
    expect(runGoalDriverMock).not.toHaveBeenCalled();
    expect(session.goal).toBeUndefined();
  });

  it("does not TTL-clean a session while its turn lane is active", async () => {
    const { handler } = makeHandler();
    await handler.onMessage(msg({ type: "init", sessionId: "g-active-ttl" }));
    const session = sessionObjs.get("g-active-ttl")!;
    const goalRun = deferred();
    runGoalDriverMock.mockImplementationOnce(async () => goalRun.promise);

    const goalTurn = handler.onMessage(msg({ type: "goal-create", content: "长任务" }));
    await vi.waitFor(() => expect(runGoalDriverMock).toHaveBeenCalledTimes(1));
    session.lastActivity = 0;
    expect(cleanupStaleSessions(31 * 60 * 1_000)).toBe(0);

    const replacement = makeHandler();
    await replacement.handler.onMessage(msg({ type: "init", sessionId: "g-active-ttl" }));
    expect(createSessionMock).toHaveBeenCalledTimes(1);

    goalRun.resolve();
    await goalTurn;
    session.lastActivity = 0;
    expect(cleanupStaleSessions(31 * 60 * 1_000)).toBe(1);
    const afterCleanup = makeHandler();
    await afterCleanup.handler.onMessage(msg({ type: "init", sessionId: "g-active-ttl" }));
    expect(createSessionMock).toHaveBeenCalledTimes(2);
  });

  it("does not TTL-clean a session that owns a current abort controller", async () => {
    const { handler } = makeHandler();
    await handler.onMessage(msg({ type: "init", sessionId: "g-active-abort" }));
    const session = sessionObjs.get("g-active-abort")!;
    session.lastActivity = 0;
    session.currentAbort = new AbortController();

    expect(cleanupStaleSessions(31 * 60 * 1_000)).toBe(0);
    session.currentAbort = undefined;
    expect(cleanupStaleSessions(31 * 60 * 1_000)).toBe(1);
  });
});
