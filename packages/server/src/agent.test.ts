import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentEventType } from "@pocket-code/wire";

// ── Mocks ────────────────────────────────────────────────
// runAgentLoop is replaced; all other agent-core exports (fromLegacyAiSdkMessages,
// buildSystemPrompt, etc.) stay real so history conversion behaves normally.
const runAgentLoopMock = vi.fn();
const compactHistoryMock = vi.fn();
vi.mock("@pocket-code/agent-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pocket-code/agent-core")>();
  return {
    ...actual,
    runAgentLoop: (...args: unknown[]) => runAgentLoopMock(...args),
    compactHistory: (...args: unknown[]) => compactHistoryMock(...args),
  };
});

const saveSessionMock = vi.fn();
const saveSessionGoalMock = vi.fn();
const getSessionMock = vi.fn((..._args: unknown[]) => null as unknown);
vi.mock("./db.js", () => ({
  saveSession: (...args: unknown[]) => saveSessionMock(...args),
  saveSessionGoal: (...args: unknown[]) => saveSessionGoalMock(...args),
  getSession: (...args: unknown[]) => getSessionMock(...args),
}));

const getWorkspaceHandleMock = vi.fn((request: { projectId: string }) => ({
  projectId: request.projectId,
  replicaId: "0f3d985e-0a3a-458e-932d-c89dbbf671c6",
  generation: 1,
  storageUri: "file:///tmp/ws",
  shellPath: "/tmp/ws",
  worktreeRoot: `/tmp/ws/${request.projectId}`,
  stateRoot: "/tmp/state",
  cacheRoot: "/tmp/cache",
  capabilities: { read: true, write: true, execute: true, syncBack: true },
}));
vi.mock("./tools.js", () => ({
  getWorkspaceRoot: vi.fn(() => "/tmp/ws"),
  getWorkspaceHandle: (...args: unknown[]) =>
    getWorkspaceHandleMock(args[0] as { projectId: string }),
}));

const createNodeModelClientMock = vi.fn((..._args: unknown[]) => ({ streamStep: vi.fn() }));
vi.mock("./nodeModelClient.js", () => ({
  createNodeModelClient: (...args: unknown[]) => createNodeModelClientMock(...args),
}));

vi.mock("./nodeBackend.js", () => ({
  createNodeBackend: vi.fn(() => ({})),
}));

// createOpenAI 换成可观测的假工厂:返回的 provider 把创建时的 apiKey 附在模型对象上,
// 便于断言"某个 modelKey 最终用的是哪把 key"。
vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: (opts: { apiKey: string; baseURL?: string }) =>
    (modelId: string) => ({ modelId, apiKey: opts.apiKey, baseURL: opts.baseURL }),
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
const { runAgent, createSession } = await import("./agent.js");
const { createGoal } = await import("./goal/types.js");
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
  getSessionMock.mockReset();
  getSessionMock.mockReturnValue(null);
  saveSessionGoalMock.mockReset();
  getWorkspaceHandleMock.mockClear();
  // 缺省透传(未压缩):既有用例零改动
  compactHistoryMock.mockReset();
  compactHistoryMock.mockImplementation(async ({ history }: { history: unknown[] }) => ({ history }));
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

    // P16 D-P16-1 后:防御路径也返回 TurnOutcome(error),不再是 void
    await expect(runAgent(session, "new message", onEvent)).resolves.toEqual({
      stopReason: "error",
      usage: { inputTokens: 0, outputTokens: 0 },
    });

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

  it("P15: compaction result → history-compacted event before loop events, compacted history persisted and passed to loop", async () => {
    const compacted = [
      { role: "user", content: "[对话历史摘要]…" },
      { role: "user", content: "近期请求" },
      { role: "assistant", content: "近期答复" },
    ];
    const compactionResult = { tokensBefore: 70000, tokensAfter: 900, compactedMessages: 20, keptRecentTurns: 2 };
    compactHistoryMock.mockResolvedValue({ history: compacted, result: compactionResult });
    runAgentLoopMock.mockResolvedValue({
      messages: [...compacted, { role: "user", content: "hi" }, { role: "assistant", content: "ok" }],
      fullText: "ok", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 }, steps: 1,
    });
    const { events, onEvent } = collectEvents();
    const session = makeSession({ messages: [{ role: "user", content: "old" }, { role: "assistant", content: "old-reply" }] });
    await runAgent(session, "hi", onEvent);

    const compactIdx = events.findIndex((e) => e.type === "history-compacted");
    expect(compactIdx).toBeGreaterThanOrEqual(0);
    expect(events[compactIdx]).toEqual({ type: "history-compacted", ...compactionResult });
    expect(events.at(-1)!.type).toBe("done"); // done 照常收尾
    // 压缩形态先落库(第一次 saveSession 载荷即 compacted),loop 后再落一次
    expect(saveSessionMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(saveSessionMock.mock.calls[0][2]).toBe(compacted);
    // loop 收到压缩后的 history
    expect((runAgentLoopMock.mock.calls[0][0] as any).history).toBe(compacted);
  });

  it("P15: no compaction (default passthrough) → no event, single saveSession (regression)", async () => {
    runAgentLoopMock.mockResolvedValue({
      messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "ok" }],
      fullText: "ok", stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, steps: 1,
    });
    const { events, onEvent } = collectEvents();
    await runAgent(makeSession(), "hi", onEvent);
    expect(events.some((e) => e.type === "history-compacted")).toBe(false);
    expect(saveSessionMock).toHaveBeenCalledTimes(1);
  });

  it("CLI path is unaffected: modelKey='claude-code' delegates to runCliSession, runAgentLoop is not called", async () => {
    const session = makeSession({ modelKey: "claude-code" });
    const { events, onEvent } = collectEvents();

    const outcome = await runAgent(session, "hi", onEvent);

    expect(runCliSessionMock).toHaveBeenCalledTimes(1);
    expect(runAgentLoopMock).not.toHaveBeenCalled();
    expect(saveSessionMock).toHaveBeenCalledTimes(1);
    expect(outcome).toBeUndefined(); // P16 D-P16-1:CLI 路径无 turn 结果
  });

  it("P16: runAgent returns { stopReason, usage } on builtin path (D-P16-1)", async () => {
    runAgentLoopMock.mockResolvedValue({
      messages: [], fullText: "",
      stopReason: "max_steps", usage: { inputTokens: 9, outputTokens: 4 }, steps: 25,
    });
    const { onEvent } = collectEvents();
    const outcome = await runAgent(makeSession(), "hi", onEvent);
    expect(outcome).toEqual({ stopReason: "max_steps", usage: { inputTokens: 9, outputTokens: 4 } });
  });

  it("P16: active goal → system contains injection, extraTools carries updateGoalStatus (C16-7/8)", async () => {
    runAgentLoopMock.mockResolvedValue({
      messages: [], fullText: "",
      stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, steps: 1,
    });
    const session = makeSession();
    (session as any).goal = createGoal("清零 lint 错误", undefined, 20);
    (session as any).goal.stats.turns = 2;
    const { onEvent } = collectEvents();
    await runAgent(session, "[goal continuation] …", onEvent);
    const opts = runAgentLoopMock.mock.calls[0][0] as any;
    expect(opts.system).toContain("Goal 模式");
    expect(opts.system).toContain("清零 lint 错误");
    expect(opts.system).toContain("2/20");
    expect(opts.extraTools?.map((t: any) => t.schema.name)).toEqual(["updateGoalStatus"]);
  });

  it("P16: non-goal turn has no injection and no extraTools (C16-7)", async () => {
    runAgentLoopMock.mockResolvedValue({
      messages: [], fullText: "",
      stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, steps: 1,
    });
    const { onEvent } = collectEvents();
    await runAgent(makeSession(), "hi", onEvent);
    const opts = runAgentLoopMock.mock.calls[0][0] as any;
    expect(opts.system).not.toContain("Goal 模式");
    expect(opts.extraTools).toBeUndefined();
  });

  it("P16: createSession restores goal with active→paused downgrade (C16-6)", async () => {
    const activeGoal = createGoal("长跑目标");
    getSessionMock.mockReturnValue({
      sessionId: "s1", userId: "u1", projectId: "", title: "",
      messages: [], modelKey: "deepseek-v4-flash",
      goalJson: JSON.stringify(activeGoal),
      createdAt: 1, updatedAt: 1,
    });
    const session = await createSession("s1", "u1");
    expect((session as any).goal.status).toBe("paused");
    expect((session as any).goal.stopReason).toContain("重启");
    expect(saveSessionGoalMock).toHaveBeenCalled(); // 降级态回写
    getSessionMock.mockReturnValue(null);
  });

  it("createSession resolves a restored session from its saved project before workspace lookup", async () => {
    const savedProjectId = "10ed836e-ae48-4d67-9e26-a74cbf55a52e";
    getSessionMock.mockReturnValue({
      sessionId: "saved",
      userId: "u1",
      projectId: savedProjectId,
      title: "",
      messages: [],
      modelKey: "deepseek-v4-flash",
      goalJson: null,
      createdAt: 1,
      updatedAt: 1,
    });

    const session = await createSession("saved", "u1");
    expect(getWorkspaceHandleMock).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: savedProjectId, userId: "u1" }),
    );
    expect(session.projectId).toBe(savedProjectId);
    expect(session.workspace).toBe(`/tmp/ws/${savedProjectId}`);
  });

  it("createSession rejects restored session reuse by another project or user", async () => {
    getSessionMock.mockReturnValue({
      sessionId: "saved",
      userId: "u1",
      projectId: "10ed836e-ae48-4d67-9e26-a74cbf55a52e",
      title: "",
      messages: [],
      modelKey: "deepseek-v4-flash",
      goalJson: null,
      createdAt: 1,
      updatedAt: 1,
    });
    await expect(
      createSession("saved", "u1", "018f00d2-8931-7bc0-aad1-1ec83b13f982"),
    ).rejects.toThrow("project");
    await expect(createSession("saved", "u2")).rejects.toThrow("user");
    expect(getWorkspaceHandleMock).not.toHaveBeenCalled();
  });
});

// ── DeepSeek 路由:设置 DEEPSEEK_API_KEY 时 v4 系列走官方端点,否则回退硅基流动 ──
describe("getModel 的 DeepSeek 路由", () => {
  it("设置 DEEPSEEK_API_KEY 时 v4 系列走官方端点(官方模型 id + DEEPSEEK_API_KEY)", async () => {
    vi.resetModules();
    vi.stubEnv("DEEPSEEK_API_KEY", "dsk-env");
    vi.stubEnv("SILICONFLOW_API_KEY", "sfk-env");
    try {
      const mod = await import("./agent.js");
      const pro = mod.getModel("deepseek-v4-pro") as any;
      expect(pro.apiKey).toBe("dsk-env");
      expect(pro.baseURL).toBe("https://api.deepseek.com");
      expect(pro.modelId).toBe("deepseek-v4-pro");
      const flash = mod.getModel("deepseek-v4-flash") as any;
      expect(flash.apiKey).toBe("dsk-env");
      expect(flash.modelId).toBe("deepseek-v4-flash");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("v3/r1 官方平台没有,即使设了 DEEPSEEK_API_KEY 也始终走硅基流动 + SILICONFLOW_API_KEY", async () => {
    vi.resetModules();
    vi.stubEnv("DEEPSEEK_API_KEY", "dsk-env");
    vi.stubEnv("SILICONFLOW_API_KEY", "sfk-env");
    try {
      const mod = await import("./agent.js");
      for (const key of ["deepseek-v3", "deepseek-r1"]) {
        const m = mod.getModel(key) as any;
        expect(m.apiKey, key).toBe("sfk-env");
        expect(m.baseURL, key).toBe("https://api.siliconflow.cn/v1");
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("未设置 DEEPSEEK_API_KEY(或为空串)时 v4 系列回退硅基流动 + SILICONFLOW_API_KEY", async () => {
    vi.resetModules();
    vi.stubEnv("DEEPSEEK_API_KEY", ""); // 清掉宿主环境可能残留的值,空串按未设置处理
    vi.stubEnv("SILICONFLOW_API_KEY", "sfk-env");
    try {
      const mod = await import("./agent.js");
      const m = mod.getModel("deepseek-v4-flash") as any;
      expect(m.apiKey).toBe("sfk-env");
      expect(m.baseURL).toBe("https://api.siliconflow.cn/v1");
      expect(m.modelId).toBe("deepseek-ai/DeepSeek-V4-Flash");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("qwen 等其余硅基流动模型不受 DEEPSEEK_API_KEY 影响", async () => {
    vi.resetModules();
    vi.stubEnv("DEEPSEEK_API_KEY", "dsk-env");
    vi.stubEnv("SILICONFLOW_API_KEY", "sfk-env");
    try {
      const mod = await import("./agent.js");
      expect((mod.getModel("qwen-coder") as any).apiKey).toBe("sfk-env");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("DEEPSEEK_BASE_URL 可覆盖官方端点", async () => {
    vi.resetModules();
    vi.stubEnv("DEEPSEEK_API_KEY", "dsk-env");
    vi.stubEnv("DEEPSEEK_BASE_URL", "https://proxy.example.com/v1");
    try {
      const mod = await import("./agent.js");
      expect((mod.getModel("deepseek-v4-flash") as any).baseURL).toBe("https://proxy.example.com/v1");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
