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
    runAgentLoopMock.mockResolvedValue({ messages: returnedMessages, fullText: "ok" });

    const session = makeSession({ modelKey: "claude-sonnet" });
    const { events, onEvent } = collectEvents();

    await runAgent(session, "hi", onEvent);

    expect(events[events.length - 1]).toEqual({ type: "done" });
    expect(session.messages).toBe(returnedMessages);
    expect(saveSessionMock).toHaveBeenCalledWith(
      "s1",
      "u1",
      returnedMessages,
      "claude-sonnet",
      ""
    );
  });

  it("error path: runAgentLoop rejects — still emits done, saves session, rebuilds messages as history+user (no half-baked state), does not rethrow", async () => {
    runAgentLoopMock.mockRejectedValue(new Error("model down"));

    const session = makeSession({
      modelKey: "claude-sonnet",
      messages: [{ role: "user", content: "previous" }, { role: "assistant", content: "prev reply" }],
    });
    const { events, onEvent } = collectEvents();

    await expect(runAgent(session, "new message", onEvent)).resolves.toBeUndefined();

    expect(events[events.length - 1]).toEqual({ type: "done" });
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
    runAgentLoopMock.mockResolvedValue({ messages: [], fullText: "" });

    const session = makeSession({ modelKey: "auto" });
    const { events, onEvent } = collectEvents();

    await runAgent(session, "hi", onEvent);

    const modelSelectedEvent = events.find((e) => e.type === "model-selected");
    expect(modelSelectedEvent).toBeDefined();
    const selectedKey = (modelSelectedEvent as any).modelKey;
    expect(selectedKey).not.toBe("auto");

    expect(createNodeModelClientMock).toHaveBeenCalledWith(selectedKey);
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
