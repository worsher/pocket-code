import "dotenv/config";
import { anthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { google } from "@ai-sdk/google";
import { getWorkspaceHandle, getWorkspaceRoot } from "./tools.js";
import { mkdir } from "fs/promises";
import { saveSession, getSession, saveSessionGoal } from "./db.js";
import { makeUpdateGoalStatusTool, type GoalState } from "./goal/types.js";
import { analyzePrompt } from "./modelRouter.js";
import { cliAdapters, runCliSession } from "./cli/index.js";
import type { AgentEventType } from "@pocket-code/wire";
import {
  runAgentLoop,
  compactHistory,
  fromLegacyAiSdkMessages,
  buildSystemPrompt,
  buildGoalInjection,
  type CoreMessage,
  type LoopStopReason,
  type ToolDef,
} from "@pocket-code/agent-core";
import { createNodeModelClient } from "./nodeModelClient.js";
import { createNodeBackend } from "./nodeBackend.js";
import { isUuid, type WorkspaceHandle } from "@pocket-code/workspace-core";

export type ModelProvider =
  | "anthropic"
  | "openai"
  | "google"
  | "siliconflow"
  | "iflow"
  | "cli-claude"
  | "cli-gemini"
  | "cli-codex";

interface ModelConfig {
  provider: ModelProvider;
  modelId: string;
}

/**
 * Supported models:
 * - claude-sonnet / claude-haiku: Anthropic Claude
 * - gpt-4o / gpt-4o-mini: OpenAI
 * - gemini-flash: Google Gemini
 * - deepseek-v4-pro / deepseek-v4-flash / deepseek-r1: DeepSeek via SiliconFlow (硅基流动)
 * - qwen-coder: Qwen via SiliconFlow
 * - glm-4-6: GLM-4.6 via iFlow (心流)
 */
const MODEL_MAP: Record<string, ModelConfig> = {
  // Anthropic
  "claude-sonnet": { provider: "anthropic", modelId: "claude-sonnet-4-5-20250929" },
  "claude-haiku": { provider: "anthropic", modelId: "claude-haiku-4-5-20251001" },
  // OpenAI
  "gpt-4o": { provider: "openai", modelId: "gpt-4o" },
  "gpt-4o-mini": { provider: "openai", modelId: "gpt-4o-mini" },
  // Google
  "gemini-flash": { provider: "google", modelId: "gemini-2.5-flash-preview-05-20" },
  // SiliconFlow (硅基流动) — DeepSeek / Qwen etc.
  "deepseek-v4-pro": { provider: "siliconflow", modelId: "deepseek-ai/DeepSeek-V4-Pro" },
  "deepseek-v4-flash": { provider: "siliconflow", modelId: "deepseek-ai/DeepSeek-V4-Flash" },
  // 旧 key 保留:老会话历史里存的 modelKey 仍可解析(App 列表已不展示)
  "deepseek-v3": { provider: "siliconflow", modelId: "deepseek-ai/DeepSeek-V3" },
  "deepseek-r1": { provider: "siliconflow", modelId: "deepseek-ai/DeepSeek-R1" },
  "qwen-coder": { provider: "siliconflow", modelId: "Qwen/Qwen2.5-Coder-32B-Instruct" },
  // iFlow (心流) — GLM series (OpenAI-compatible)
  "glm-4-6": { provider: "iflow", modelId: "glm-4.6" },
  // CLI providers — use server-side installed CLI tools with Pro subscription
  "claude-code": { provider: "cli-claude", modelId: "claude-code" },
  "gemini-cli": { provider: "cli-gemini", modelId: "gemini-cli" },
  codex: { provider: "cli-codex", modelId: "codex" },
};

/** SiliconFlow uses OpenAI-compatible API */
const siliconflow = createOpenAI({
  baseURL: process.env.SILICONFLOW_BASE_URL || "https://api.siliconflow.cn/v1",
  apiKey: process.env.SILICONFLOW_API_KEY || "",
});

/**
 * DeepSeek 官方开放平台(platform.deepseek.com,OpenAI 兼容)。
 * 设置 DEEPSEEK_API_KEY 时 v4 系列优先走官方端点;未设置则回退硅基流动。
 * 注意官方 key 与硅基流动 key 不通用,不能只换 key 不换端点。
 */
const deepseekOfficial = createOpenAI({
  baseURL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
  apiKey: process.env.DEEPSEEK_API_KEY || "",
});

/** 官方平台可用模型:硅基流动 modelId → 官方 modelId(v3/r1 官方未提供,始终走硅基流动) */
const DEEPSEEK_OFFICIAL_IDS: Record<string, string> = {
  "deepseek-ai/DeepSeek-V4-Pro": "deepseek-v4-pro",
  "deepseek-ai/DeepSeek-V4-Flash": "deepseek-v4-flash",
};

/** iFlow (心流) uses OpenAI-compatible API */
const iflow = createOpenAI({
  baseURL: process.env.IFLOW_BASE_URL || "https://apis.iflow.cn/v1",
  apiKey: process.env.IFLOW_API_KEY || "",
});

/** Standard OpenAI */
const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY || "",
});

export function getModel(modelKey: string) {
  const config = MODEL_MAP[modelKey] || MODEL_MAP["deepseek-v4-flash"];
  switch (config.provider) {
    case "anthropic":
      return anthropic(config.modelId);
    case "openai":
      return openai(config.modelId);
    case "google":
      return google(config.modelId);
    case "siliconflow": {
      // DeepSeek v4 系列:设置 DEEPSEEK_API_KEY 时走官方端点,否则回退硅基流动
      const officialId = DEEPSEEK_OFFICIAL_IDS[config.modelId];
      if (officialId && process.env.DEEPSEEK_API_KEY) {
        return deepseekOfficial(officialId);
      }
      return siliconflow(config.modelId);
    }
    case "iflow":
      return iflow(config.modelId);
    default:
      // CLI providers are handled before getModel() is called; this should never be reached
      throw new Error(`Unsupported provider: ${config.provider}`);
  }
}

const AGENT_MAX_STEPS = parseInt(process.env.AGENT_MAX_STEPS || "25", 10);
// P15:turn 边界上下文压缩(spec §6);阈值/保留轮数可经环境变量调
const COMPACT_THRESHOLD = parseInt(process.env.AGENT_COMPACT_THRESHOLD || "60000", 10);
const COMPACT_KEEP_TURNS = parseInt(process.env.AGENT_COMPACT_KEEP_TURNS || "2", 10);

export interface AgentSession {
  sessionId: string;
  userId: string;
  /** Project this session belongs to (empty string = legacy per-session workspace) */
  projectId: string;
  workspace: string;
  /** Present for UUID projects; legacy sessions remain path-compatible only. */
  workspaceHandle?: WorkspaceHandle;
  messages: CoreMessage[];
  modelKey: string;
  /** Docker container ID (only set when Docker isolation is enabled) */
  containerId?: string;
  /** Custom project instructions (appended to system prompt) */
  customPrompt?: string;
  /** Project-bound credential metadata only; the secret stays in the server Vault. */
  gitCredentialProfileId?: string;
  /** CLI 委托续接会话 id,按 adapter.id 分槽。 */
  cliSessions?: Record<string, string>;
  /** 进行中 turn 的中止控制(session 级:断线重连后任何连接均可 abort,P14 D-P14-3)。 */
  currentAbort?: AbortController;
  /** Identifies which lane activity owns currentAbort so goal controls cannot abort a normal turn. */
  currentAbortOwner?: "message" | "goal";
  /** 当前目标(P16;同一 session 至多一个,complete/cancel 即清除)。 */
  goal?: GoalState;
  /** Timestamp of last activity, used for TTL cleanup */
  lastActivity: number;
}

export async function createSession(
  sessionId: string,
  userId: string,
  projectId: string = ""
): Promise<AgentSession> {
  // Restore ownership/project identity before resolving the physical path. The
  // old order could restore project B while retaining project A's workspace.
  const saved = getSession(sessionId);
  if (saved && saved.userId !== userId) {
    throw new Error("Session does not belong to this user.");
  }
  if (saved?.projectId && projectId && saved.projectId !== projectId) {
    throw new Error("Session does not belong to this project.");
  }
  const effectiveProjectId = saved?.projectId || projectId;
  const workspaceHandle =
    effectiveProjectId && isUuid(effectiveProjectId)
      ? getWorkspaceHandle({ sessionId, projectId: effectiveProjectId, userId })
      : undefined;
  const workspace =
    workspaceHandle?.worktreeRoot ??
    getWorkspaceRoot({
      sessionId,
      projectId: effectiveProjectId || undefined,
      userId,
    });
  await mkdir(workspace, { recursive: true });
  if (workspaceHandle) {
    await Promise.all([
      mkdir(workspaceHandle.stateRoot, { recursive: true }),
      mkdir(workspaceHandle.cacheRoot, { recursive: true }),
    ]);
  }

  if (saved) {
    const session: AgentSession = {
      sessionId,
      userId,
      projectId: effectiveProjectId,
      workspace,
      workspaceHandle,
      messages: saved.messages,
      modelKey: saved.modelKey,
      lastActivity: Date.now(),
    };
    // P16 C16-6:恢复 goal;active → paused 降级(旧进程的 turn 必已死,
    // 自动续跑会在无人监督下偷偷烧钱)。降级态立即回写。
    if (saved.goalJson) {
      try {
        const goal = JSON.parse(saved.goalJson) as GoalState;
        if (goal.status === "active") {
          goal.status = "paused";
          goal.stopReason = "进程重启,已暂停";
          goal.updatedAt = Date.now();
          saveSessionGoal(sessionId, JSON.stringify(goal));
        }
        session.goal = goal;
      } catch {
        // 损坏的 goal JSON:忽略(等价无目标)
      }
    }
    return session;
  }

  return {
    sessionId,
    userId,
    projectId,
    workspace,
    workspaceHandle,
    messages: [],
    modelKey: "deepseek-v4-flash",
    lastActivity: Date.now(),
  };
}

export interface ImageData {
  base64: string;
  mimeType: string;
}

/** P16 D-P16-1:turn 结果(goal driver 的决策输入);CLI 路径不产生。 */
export interface TurnOutcome {
  stopReason: LoopStopReason;
  usage: { inputTokens: number; outputTokens: number };
}

export async function runAgent(
  session: AgentSession,
  userMessage: string,
  onEvent: (event: AgentEventType) => void,
  signal?: AbortSignal,
  images?: ImageData[]
): Promise<TurnOutcome | undefined> {
  // ── CLI routing: 注册表命中即委托本机 CLI 工具 ──
  const cliAdapter = cliAdapters[session.modelKey];
  if (cliAdapter) {
    session.messages.push({ role: "user", content: userMessage });
    await runCliSession(cliAdapter, session, userMessage, onEvent, signal);
    saveSession(
      session.sessionId,
      session.userId,
      session.messages,
      session.modelKey,
      session.projectId
    );
    return undefined;
  }

  // Smart model routing: auto-select model based on prompt complexity
  let effectiveModelKey = session.modelKey;
  if (session.modelKey === "auto") {
    // 对齐旧行为:分析时含本轮 user 消息(旧代码先 push 本轮消息再分析,historyLength 含它)。
    const analysis = analyzePrompt(
      userMessage,
      [...session.messages, { role: "user", content: userMessage }],
      !!images?.length
    );
    effectiveModelKey = analysis.suggestedModel;
    onEvent({ type: "model-selected", modelKey: effectiveModelKey, reason: analysis.reason });
    console.log(`[Router] auto → ${effectiveModelKey} (${analysis.reason})`);
  }

  console.log(`[Agent] model=${effectiveModelKey}, message="${userMessage.slice(0, 80)}"`);

  const history = fromLegacyAiSdkMessages(session.messages);
  // catch 兜底也要用压缩后形态(若压缩已落库,回退到未压缩史会复活已摘要的旧消息)
  let effectiveHistory = history;

  try {
    const backend = createNodeBackend(
      session.workspaceHandle ?? session.workspace,
      session.containerId,
      {
        userId: session.userId,
        credentialProfileId: session.gitCredentialProfileId,
      }
    );
    // D-P15-2:modelClient 提升,压缩与 loop 共用
    const modelClient = createNodeModelClient(effectiveModelKey);

    // C15-1:压缩只发生在 runAgentLoop 之前(turn 边界安全点);失败静默跳过
    const { history: compacted, result: compaction } = await compactHistory({
      history,
      modelClient,
      thresholdTokens: COMPACT_THRESHOLD,
      keepRecentTurns: COMPACT_KEEP_TURNS,
      signal,
    });
    if (compaction) {
      effectiveHistory = compacted;
      // D-P15-4:压缩形态先落库,turn 中途出错也不退回未压缩形态
      session.messages = compacted;
      saveSession(
        session.sessionId,
        session.userId,
        session.messages,
        session.modelKey,
        session.projectId
      );
      onEvent({ type: "history-compacted", ...compaction });
      console.log(
        `[Agent] Compacted history: ${compaction.tokensBefore} → ${compaction.tokensAfter} tokens (${compaction.compactedMessages} messages)`
      );
    }

    // P16 C16-7/8:goal 注入与 updateGoalStatus 工具仅 goal turn 存在;
    // 注入在 turn 边界一次性完成(system 在 step 间不变)。
    let system = buildSystemPrompt({
      customPrompt: session.customPrompt,
      // 与 execTools 能力门控(需 startProcess && stopProcess)判据对称,
      // 防未来出现只实现其一的 backend 时 prompt 宣传与工具注册分叉。
      supportsBackground: !!(backend.startProcess && backend.stopProcess),
      hasBoundGitCredential: !!session.gitCredentialProfileId,
    });
    let extraTools: ToolDef[] | undefined;
    if (session.goal?.status === "active") {
      system += buildGoalInjection({
        goal: session.goal.goal,
        acceptance: session.goal.acceptance,
        turns: session.goal.stats.turns,
        maxTurns: session.goal.budgets.maxTurns,
      });
      extraTools = [makeUpdateGoalStatusTool(session)];
    }

    const result = await runAgentLoop({
      modelClient,
      backend,
      workspace: session.workspace,
      system,
      extraTools,
      history: effectiveHistory,
      userMessage,
      images,
      onEvent,
      signal,
      maxSteps: AGENT_MAX_STEPS,
    });

    // loop 返回的 messages 已含本轮 user 消息(error 时含部分进度,spec D1);
    // 此后持久化即 CoreMessage 格式。
    session.messages = result.messages;

    // Persist to database
    saveSession(
      session.sessionId,
      session.userId,
      session.messages,
      session.modelKey,
      session.projectId
    );

    onEvent({ type: "done", stopReason: result.stopReason, usage: result.usage });
    return { stopReason: result.stopReason, usage: result.usage };
  } catch (err: any) {
    // P12 后 loop 不再抛错(错误收敛为返回值),此 catch 仅编程 bug 兜底:
    // 保留 loop 前的历史 + 本轮 user 消息落盘,尽力保留语境。
    console.error("[Agent] Error:", err.message);
    const userContent =
      images && images.length > 0
        ? [
            { type: "text" as const, text: userMessage },
            ...images.map((img) => ({ type: "image" as const, ...img })),
          ]
        : userMessage;
    session.messages = [...effectiveHistory, { role: "user", content: userContent }];
    saveSession(
      session.sessionId,
      session.userId,
      session.messages,
      session.modelKey,
      session.projectId
    );
    onEvent({ type: "done", stopReason: "error" });
    return { stopReason: "error", usage: { inputTokens: 0, outputTokens: 0 } };
  }
}
