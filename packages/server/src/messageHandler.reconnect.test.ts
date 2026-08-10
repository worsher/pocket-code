// ── P14 集成:断线续跑 + 重连补发(spec C14-4/5/6,D-P14-1/3/5) ──
// runAgent 全程 mock 为手动驱动的发射器:测试可在 turn 进行中触发 onClose、
// 继续发事件、再以新 handler(新连接)init 协商补发。

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ServerOutboundType } from "@pocket-code/wire";
import { getSessionStream, _resetStreams, _MAX_EVENTS } from "./eventBuffer.js";

// ── Mocks(messageHandler 的依赖面;auth 走 preAuth 免 mock)──
interface RunHandle {
  onEvent: (e: unknown) => void;
  signal?: AbortSignal;
  finish: () => void;
}
let currentRun: RunHandle | null = null;
const PROJECT_A = "10ed836e-ae48-4d67-9e26-a74cbf55a52e";
const PROJECT_B = "018f00d2-8931-7bc0-aad1-1ec83b13f982";
const REPLICA_ID = "0f3d985e-0a3a-458e-932d-c89dbbf671c6";
const AUTHORITY_ID = "ce393574-d077-4ddf-a34a-bd9746277f97";

const runAgentMock = vi.fn(
  (_session: unknown, _content: string, onEvent: (e: unknown) => void, signal?: AbortSignal) =>
    new Promise<void>((resolve) => {
      currentRun = { onEvent, signal, finish: () => resolve() };
    })
);

vi.mock("./agent.js", () => ({
  createSession: vi.fn(async (sessionId: string, userId: string, projectId = "") => {
    const workspace = "/tmp/ws";
    return {
      sessionId,
      userId,
      projectId,
      workspace,
      workspaceHandle: projectId
        ? {
            projectId,
            replicaId: REPLICA_ID,
            generation: 2,
            worktreeRoot: workspace,
          }
        : undefined,
      messages: [],
      modelKey: "deepseek-v4-flash",
      lastActivity: Date.now(),
    };
  }),
  runAgent: (...args: unknown[]) =>
    runAgentMock(args[0], args[1] as string, args[2] as (e: unknown) => void, args[3] as AbortSignal),
}));

vi.mock("./db.js", () => ({
  initDb: vi.fn(async () => {}),
  listUserSessions: vi.fn(() => []),
  deleteSession: vi.fn(() => true),
  getWorkspaceAuthorityId: vi.fn(() => AUTHORITY_ID),
  updateWorkspaceProjectDisplayName: vi.fn(),
  listWorkspaceProjects: vi.fn(() => [
    {
      userId: "u1",
      projectId: PROJECT_A,
      replicaId: REPLICA_ID,
      storageKey: "ws_0f3d985e0a3a458e932dc89dbbf671c6",
      displayName: "Remote A",
      generation: 2,
      createdAt: 1,
      updatedAt: 2,
    },
  ]),
}));

vi.mock("./docker.js", () => ({
  isDockerEnabled: () => false,
  getContainer: vi.fn(),
}));

vi.mock("./resourceLimits.js", () => ({
  checkQuota: () => ({ allowed: true }),
  incrementUsage: vi.fn(),
  getUserQuota: vi.fn(() => ({ userId: "u1", tier: "free", limits: {}, usage: {} })),
}));

vi.mock("./gitCredentials.js", () => ({ setupGitCredentials: vi.fn() }));
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
  currentRun = null;
  runAgentMock.mockClear();
});

describe("messageHandler — P14 事件流", () => {
  it("negotiates an authoritative v2 scope and scopes file events", async () => {
    const { sent, handler } = makeHandler();
    await handler.onMessage(
      msg({
        type: "init",
        workspaceProtocolVersion: 2,
        sessionId: "scope-v2",
        projectId: PROJECT_A,
      }),
    );
    expect(sent.find((event) => event.type === "session")).toMatchObject({
      workspaceProtocolVersion: 2,
      workspaceScope: {
        projectId: PROJECT_A,
        replicaId: REPLICA_ID,
        sessionId: "scope-v2",
        workspaceGeneration: 2,
        authorityId: AUTHORITY_ID,
        replicaKind: "cloud",
      },
      workspaceCatalog: [
        expect.objectContaining({
          projectId: PROJECT_A,
          displayName: "Remote A",
          replicaId: REPLICA_ID,
        }),
      ],
    });

    const turn = handler.onMessage(msg({ type: "message", content: "change file" }));
    await vi.waitFor(() => expect(currentRun).not.toBeNull());
    currentRun!.onEvent({ type: "file-changed", path: "a.ts", changeType: "modified" });
    currentRun!.finish();
    await turn;
    expect(sent.find((event) => event.type === "file-changed")).toMatchObject({
      workspaceScope: {
        projectId: PROJECT_A,
        replicaId: REPLICA_ID,
        workspaceGeneration: 2,
      },
    });
  });

  it("rejects reusing one in-memory session id across projects", async () => {
    const { sent, handler } = makeHandler();
    await handler.onMessage(
      msg({ type: "init", sessionId: "cross-project", projectId: PROJECT_A }),
    );
    await handler.onMessage(
      msg({ type: "init", sessionId: "cross-project", projectId: PROJECT_B }),
    );
    expect(sent.at(-1)).toEqual({
      type: "error",
      error: "Session does not belong to this project.",
    });
  });

  it("① events carry strictly increasing seq; session ack carries eventEpoch/currentSeq", async () => {
    const { sent, handler } = makeHandler();
    await handler.onMessage(msg({ type: "init", sessionId: "p14-a" }));
    const ack = sent.find((m) => m.type === "session") as any;
    expect(ack.eventEpoch).toMatch(/^ep_/);
    expect(ack.currentSeq).toBe(0);

    const turn = handler.onMessage(msg({ type: "message", content: "go" }));
    await vi.waitFor(() => expect(currentRun).not.toBeNull());
    currentRun!.onEvent({ type: "text-delta", text: "a" });
    currentRun!.onEvent({ type: "tool-call", callId: "c1", name: "listFiles", args: {} });
    currentRun!.onEvent({ type: "done", stopReason: "end_turn" });
    currentRun!.finish();
    await turn;

    const evs = sent.filter((m: any) => typeof m.seq === "number") as any[];
    expect(evs.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(evs.map((e) => e.type)).toEqual(["text-delta", "tool-call", "done"]);
  });

  it("② disconnect mid-turn: turn keeps running (no abort), events buffer, new handler replays gap then joins live (C14-2/5/6)", async () => {
    const { sent: sentA, handler: A } = makeHandler();
    await A.onMessage(msg({ type: "init", sessionId: "p14-b" }));
    const epoch = (sentA.find((m) => m.type === "session") as any).eventEpoch;

    const turn = A.onMessage(msg({ type: "message", content: "long task" }));
    await vi.waitFor(() => expect(currentRun).not.toBeNull());
    const run = currentRun!;
    run.onEvent({ type: "text-delta", text: "1" });
    run.onEvent({ type: "text-delta", text: "2" });
    run.onEvent({ type: "text-delta", text: "3" });
    expect((sentA as any[]).filter((m) => typeof m.seq === "number").length).toBe(3);

    A.onClose();
    expect(run.signal?.aborted).toBe(false); // C14-6:断开不中断 turn

    run.onEvent({ type: "text-delta", text: "4" });
    run.onEvent({ type: "text-delta", text: "5" });
    run.onEvent({ type: "done", stopReason: "end_turn" });
    // 断线后 A 不再收到
    expect((sentA as any[]).filter((m) => typeof m.seq === "number").length).toBe(3);

    const { sent: sentB, handler: B } = makeHandler();
    await B.onMessage(msg({ type: "init", sessionId: "p14-b", lastSeq: 3, eventEpoch: epoch }));

    const ackIdx = sentB.findIndex((m) => m.type === "session");
    const replayed = (sentB as any[]).slice(ackIdx + 1).filter((m) => typeof m.seq === "number");
    expect(replayed.map((e) => e.seq)).toEqual([4, 5, 6]); // C14-5:ack 后按 seq 升序补齐
    // C14-2:补发与缓冲存储逐字段相等(同一对象)
    const backlog = getSessionStream("p14-b").readSince(3)!;
    expect(replayed).toEqual(backlog);

    // 补发后仍在线:后续实时事件继续到达 B
    run.onEvent({ type: "text-delta", text: "post" });
    expect((sentB as any[]).filter((m) => typeof m.seq === "number").map((e) => e.seq)).toEqual([4, 5, 6, 7]);
    run.finish();
    await turn;
  });

  it("③ epoch mismatch → resync-required(epoch-changed)", async () => {
    getSessionStream("p14-c").publish({ type: "text-delta", text: "x" });
    const { sent, handler } = makeHandler();
    await handler.onMessage(msg({ type: "init", sessionId: "p14-c", lastSeq: 1, eventEpoch: "ep_stale" }));
    const resync = sent.find((m) => m.type === "resync-required") as any;
    expect(resync).toMatchObject({ reason: "epoch-changed", currentSeq: 1 });
    expect(resync.eventEpoch).toMatch(/^ep_/);
  });

  it("④ evicted gap → resync-required(buffer-overflow)", async () => {
    const s = getSessionStream("p14-d");
    for (let i = 0; i < _MAX_EVENTS + 5; i++) s.publish({ type: "text-delta", text: `e${i}` });
    const { sent, handler } = makeHandler();
    await handler.onMessage(msg({ type: "init", sessionId: "p14-d", lastSeq: 1, eventEpoch: s.epoch }));
    expect(sent.find((m) => m.type === "resync-required")).toMatchObject({
      reason: "buffer-overflow",
      currentSeq: _MAX_EVENTS + 5,
    });
  });

  it("⑤ session-scoped abort: reconnected handler can stop a turn started on the dead connection (D-P14-3)", async () => {
    const { handler: A } = makeHandler();
    await A.onMessage(msg({ type: "init", sessionId: "p14-e" }));
    const turn = A.onMessage(msg({ type: "message", content: "long task" }));
    await vi.waitFor(() => expect(currentRun).not.toBeNull());
    const run = currentRun!;
    A.onClose();
    expect(run.signal?.aborted).toBe(false);

    const { handler: B } = makeHandler();
    await B.onMessage(msg({ type: "init", sessionId: "p14-e" }));
    await B.onMessage(msg({ type: "abort" }));
    expect(run.signal?.aborted).toBe(true);
    run.finish();
    await turn;
  });
});
