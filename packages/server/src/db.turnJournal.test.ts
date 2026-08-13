import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const atomicWriteState = vi.hoisted(() => ({
  calls: [] as string[],
  failPath: null as string | null,
}));

vi.mock("./atomicFile.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./atomicFile.js")>();
  return {
    ...actual,
    atomicWriteFileSync(path: string, data: Uint8Array): void {
      atomicWriteState.calls.push(path);
      if (path === atomicWriteState.failPath) {
        throw new Error(`injected persistence failure: ${path}`);
      }
      actual.atomicWriteFileSync(path, data);
    },
  };
});

import {
  claimTurnJournal,
  cleanupTurnJournal,
  completeTurnJournal,
  getSession,
  initDb,
  readTurnJournal,
  saveSessionGoal,
} from "./db.js";

beforeAll(async () => {
  await initDb();
});

afterEach(() => {
  atomicWriteState.calls = [];
  atomicWriteState.failPath = null;
});

const persistenceFailureCases = [
  {
    name: "backup write",
    failurePath: () => `${process.env.DB_PATH!}.backup`,
    expectedCalls: () => [`${process.env.DB_PATH!}.backup`],
  },
  {
    name: "primary write",
    failurePath: () => process.env.DB_PATH!,
    expectedCalls: () => [`${process.env.DB_PATH!}.backup`, process.env.DB_PATH!],
  },
] as const;

describe("durable turn journal", () => {
  it("persists a running claim across a database reload and never reclaims it", async () => {
    const sessionId = `running-session-${Date.now()}`;
    const turnId = "running-turn";
    const requestHash = "hash-running";

    expect(
      claimTurnJournal({
        sessionId,
        turnId,
        requestHash,
        now: 100,
        claimTokenFactory: () => "claim-running",
      })
    ).toEqual({ kind: "claimed", claimToken: "claim-running" });
    expect(readTurnJournal(sessionId, turnId)).toMatchObject({
      status: "running",
      requestHash,
      events: [],
    });

    await initDb();
    expect(claimTurnJournal({ sessionId, turnId, requestHash })).toEqual({ kind: "running" });
    expect(claimTurnJournal({ sessionId, turnId, requestHash: "different-request" })).toEqual({
      kind: "conflict",
    });
  });

  it("persists and returns the complete logical AgentEvent stream", async () => {
    const sessionId = `completed-session-${Date.now()}`;
    const turnId = "completed-turn";
    const requestHash = "hash-completed";
    const events = [
      { type: "text-delta", text: "hello", turnId },
      {
        type: "tool-result",
        callId: "tool-1",
        result: { nested: [1, "two", { ok: true }] },
        turnId,
      },
      { type: "done", stopReason: "end_turn", turnId },
    ];

    const claim = claimTurnJournal({
      sessionId,
      turnId,
      requestHash,
      claimTokenFactory: () => "claim-completed",
    });
    expect(claim).toEqual({ kind: "claimed", claimToken: "claim-completed" });
    expect(
      completeTurnJournal({
        sessionId,
        turnId,
        requestHash,
        claimToken: "wrong-owner",
        events,
      })
    ).toBe(false);
    expect(
      completeTurnJournal({
        sessionId,
        turnId,
        requestHash,
        claimToken: "claim-completed",
        events,
      })
    ).toBe(true);

    await initDb();
    expect(claimTurnJournal({ sessionId, turnId, requestHash })).toEqual({
      kind: "completed",
      events,
    });
  });

  it("prunes old completed rows but retains uncertain running rows", () => {
    const suffix = `${Date.now()}`;
    const completedSession = `cleanup-completed-${suffix}`;
    const runningSession = `cleanup-running-${suffix}`;
    const requestHash = "hash-cleanup";
    claimTurnJournal({
      sessionId: completedSession,
      turnId: "turn",
      requestHash,
      now: 100,
      claimTokenFactory: () => "claim-old-completed",
    });
    completeTurnJournal({
      sessionId: completedSession,
      turnId: "turn",
      requestHash,
      claimToken: "claim-old-completed",
      events: [{ type: "done" }],
      now: 101,
    });
    claimTurnJournal({
      sessionId: runningSession,
      turnId: "turn",
      requestHash,
      now: 100,
      claimTokenFactory: () => "claim-old-running",
    });

    expect(cleanupTurnJournal(200)).toBeGreaterThanOrEqual(1);
    expect(readTurnJournal(completedSession, "turn")).toBeNull();
    expect(readTurnJournal(runningSession, "turn")).toMatchObject({ status: "running" });
  });

  it.each(persistenceFailureCases)(
    "removes a new in-memory claim when the $name fails",
    async ({ name, failurePath, expectedCalls }) => {
      const sessionId = `claim-persist-failure-${name}-${Date.now()}`;
      const turnId = "turn";
      const requestHash = "hash-claim-persist-failure";
      atomicWriteState.failPath = failurePath();

      expect(() =>
        claimTurnJournal({
          sessionId,
          turnId,
          requestHash,
          now: 400,
          claimTokenFactory: () => "failed-claim",
        })
      ).toThrow("injected persistence failure");
      expect(atomicWriteState.calls).toEqual(expectedCalls());

      atomicWriteState.failPath = null;
      expect(readTurnJournal(sessionId, turnId)).toBeNull();
      await initDb();
      expect(readTurnJournal(sessionId, turnId)).toBeNull();
    }
  );

  it.each(persistenceFailureCases)(
    "restores the running claim when completion $name fails",
    async ({ name, failurePath, expectedCalls }) => {
      const sessionId = `complete-persist-failure-${name}-${Date.now()}`;
      const turnId = "turn";
      const requestHash = "hash-complete-persist-failure";
      const claimToken = "completion-claim";
      claimTurnJournal({
        sessionId,
        turnId,
        requestHash,
        now: 500,
        claimTokenFactory: () => claimToken,
      });
      atomicWriteState.calls = [];
      atomicWriteState.failPath = failurePath();

      expect(() =>
        completeTurnJournal({
          sessionId,
          turnId,
          requestHash,
          claimToken,
          events: [{ type: "text-delta", text: "must roll back" }, { type: "done" }],
          now: 600,
        })
      ).toThrow("injected persistence failure");
      expect(atomicWriteState.calls).toEqual(expectedCalls());

      atomicWriteState.failPath = null;
      expect(readTurnJournal(sessionId, turnId)).toMatchObject({
        requestHash,
        status: "running",
        events: [],
        createdAt: 500,
        updatedAt: 500,
        completedAt: undefined,
      });
      await initDb();
      expect(readTurnJournal(sessionId, turnId)).toMatchObject({
        requestHash,
        status: "running",
        events: [],
        createdAt: 500,
        updatedAt: 500,
        completedAt: undefined,
      });
    }
  );
});

describe("goal persistence", () => {
  it("creates the owning session when goal creation is its first durable operation", async () => {
    const sessionId = `goal-first-operation-${Date.now()}`;
    const goalJson = JSON.stringify({
      goal: "first operation",
      status: "active",
      transportTurnId: "goal-first-turn",
    });

    saveSessionGoal(sessionId, goalJson, {
      userId: "goal-first-user",
      projectId: "goal-first-project",
      messages: [],
      modelKey: "deepseek-v4-flash",
    });

    expect(getSession(sessionId)).toMatchObject({
      sessionId,
      userId: "goal-first-user",
      projectId: "goal-first-project",
      goalJson,
    });
    await initDb();
    expect(getSession(sessionId)?.goalJson).toBe(goalJson);
  });
});
