import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentEventType } from "@pocket-code/wire";

// ── Mocks ────────────────────────────────────────────────
// runAgentLoop is replaced; all other agent-core exports (fromLegacyAiSdkMessages,
// buildSystemPrompt, etc.) stay real so history conversion behaves normally.
const runAgentLoopMock = vi.fn();
vi.mock("@pocket-code/agent-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pocket-code/agent-core")>();
  return {
    ...actual,
    runAgentLoop: (...args: unknown[]) => runAgentLoopMock(...args),
  };
});

const saveSessionMock = vi.fn();
vi.mock("./db.js", () => ({
  saveSession: (...args: unknown[]) => saveSessionMock(...args),
  getSession: vi.fn(() => null),
}));

const createNodeModelClientMock = vi.fn((..._args: unknown[]) => ({ streamStep: vi.fn() }));
vi.mock("./nodeModelClient.js", () => ({
  createNodeModelClient: (...args: unknown[]) => createNodeModelClientMock(...args),
}));

vi.mock("./nodeBackend.js", () => ({
  createNodeBackend: vi.fn(() => ({})),
}));

const runCliSessionMock = vi.fn(async (...args: unknown[]) => {
  const session = args[1] as { messages: unknown[] };
  session.messages.push({ role: "assistant", content: "(cli done)" });
});
vi.mock("./cli/index.js", () => ({
  cliAdapters: { "claude-code": { id: "claude-code" } },
  runCliSession: (...args: unknown[]) => runCliSessionMock(...args),
}));

// Import after mocks are registered.
const { runAgent } = await import("./agent.js");
type AgentSession = Parameters<typeof runAgent>[0];

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    sessionId: "s1",
    userId: "u1",
    projectId: "",
    workspace: "/tmp/ws",
    messages: [],
    modelKey: "deepseek-v4-flash",
    lastActivity: Date.now(),
    ...overrides,
  } as AgentSession;
}

function collectEvents() {
  const events: AgentEventType[] = [];
  const onEvent = (e: AgentEventType) => events.push(e);
  return { events, onEvent };
}

beforeEach(() => {
  runAgentLoopMock.mockReset();
  saveSessionMock.mockReset();
  createNodeModelClientMock.mockClear();
  runCliSessionMock.mockClear();
});

describe("runAgent", () => {
  it("success path: emits done, overwrites session.messages with loop result, saves session", async () => {
    const returnedMessages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "ok" },
    ];
    runAgentLoopMock.mockResolvedValue({
      messages: returnedMessages,
      fullText: "ok",
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 2 },
      steps: 1,
    });

    const session = makeSession({ modelKey: "claude-sonnet" });
    const { events, onEvent } = collectEvents();

    await runAgent(session, "hi", onEvent);

    expect(events[events.length - 1]).toEqual({
      type: "done",
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 2 },
    });
    expect(session.messages).toBe(returnedMessages);
    expect(saveSessionMock).toHaveBeenCalledWith(
      "s1",
      "u1",
      returnedMessages,
      "claude-sonnet",
      ""
    );
  });

  it("defensive path: runAgentLoop rejects(编程 bug 兜底) — still emits done(stopReason error), saves session, rebuilds messages as history+user, does not rethrow", async () => {
    runAgentLoopMock.mockRejectedValue(new Error("model down"));

    const session = makeSession({
      modelKey: "claude-sonnet",
      messages: [{ role: "user", content: "previous" }, { role: "assistant", content: "prev reply" }],
    });
    const { events, onEvent } = collectEvents();

    await expect(runAgent(session, "new message", onEvent)).resolves.toBeUndefined();

    expect(events[events.length - 1]).toEqual({ type: "done", stopReason: "error" });
    expect(saveSessionMock).toHaveBeenCalledTimes(1);

    // session.messages should be history (converted) + this turn's user message —
    // not anything the (mocked) loop would have produced, since it rejected before returning.
    expect(session.messages).toEqual([
      { role: "user", content: "previous" },
      { role: "assistant", content: "prev reply" },
      { role: "user", content: "new message" },
    ]);
  });

  it("effectiveModelKey passthrough: modelKey='auto' resolves via analyzePrompt and is passed to createNodeModelClient, model-selected event fires", async () => {
    runAgentLoopMock.mockResolvedValue({
      messages: [], fullText: "",
      stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, steps: 1,
    });

    const session = makeSession({ modelKey: "auto" });
    const { events, onEvent } = collectEvents();

    await runAgent(session, "hi", onEvent);

    const modelSelectedEvent = events.find((e) => e.type === "model-selected");
    expect(modelSelectedEvent).toBeDefined();
    const selectedKey = (modelSelectedEvent as any).modelKey;
    expect(selectedKey).not.toBe("auto");

    expect(createNodeModelClientMock).toHaveBeenCalledWith(selectedKey);
  });

  it("done event carries stopReason and usage from loop result", async () => {
    runAgentLoopMock.mockResolvedValue({
      messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "partial" }],
      fullText: "partial", stopReason: "max_steps",
      usage: { inputTokens: 7, outputTokens: 3 }, steps: 25,
    });
    const { events, onEvent } = collectEvents();
    await runAgent(makeSession(), "hi", onEvent);
    expect(events.at(-1)).toEqual({
      type: "done", stopReason: "max_steps", usage: { inputTokens: 7, outputTokens: 3 },
    });
  });

  it("loop error result persists partial progress and done carries stopReason error", async () => {
    const partial = [{ role: "user", content: "hi" }, { role: "assistant", content: "half" }];
    runAgentLoopMock.mockResolvedValue({
      messages: partial, fullText: "half", stopReason: "error",
      usage: { inputTokens: 1, outputTokens: 1 }, steps: 1, errorMessage: "model down",
    });
    const { events, onEvent } = collectEvents();
    const session = makeSession();
    await runAgent(session, "hi", onEvent);
    expect(session.messages).toEqual(partial); // 部分进度落盘,不再重建丢弃
    expect(saveSessionMock).toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "error" });
  });

  it("CLI path is unaffected: modelKey='claude-code' delegates to runCliSession, runAgentLoop is not called", async () => {
    const session = makeSession({ modelKey: "claude-code" });
    const { events, onEvent } = collectEvents();

    await runAgent(session, "hi", onEvent);

    expect(runCliSessionMock).toHaveBeenCalledTimes(1);
    expect(runAgentLoopMock).not.toHaveBeenCalled();
    expect(saveSessionMock).toHaveBeenCalledTimes(1);
  });
});
