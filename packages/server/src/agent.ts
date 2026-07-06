import "dotenv/config";
import { anthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { google } from "@ai-sdk/google";
import { getWorkspaceRoot } from "./tools.js";
import { mkdir } from "fs/promises";
import { saveSession, getSession } from "./db.js";
import { analyzePrompt } from "./modelRouter.js";
import { cliAdapters, runCliSession } from "./cli/index.js";
import type { AgentEventType } from "@pocket-code/wire";
import {
  runAgentLoop,
  fromLegacyAiSdkMessages,
  buildSystemPrompt,
  type CoreMessage,
} from "@pocket-code/agent-core";
import { createNodeModelClient } from "./nodeModelClient.js";
import { createNodeBackend } from "./nodeBackend.js";

export type ModelProvider = "anthropic" | "openai" | "google" | "siliconflow" | "iflow" | "cli-claude" | "cli-gemini" | "cli-codex";

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
  "codex": { provider: "cli-codex", modelId: "codex" },
};

/** SiliconFlow uses OpenAI-compatible API */
const siliconflow = createOpenAI({
  baseURL: process.env.SILICONFLOW_BASE_URL || "https://api.siliconflow.cn/v1",
  apiKey: process.env.SILICONFLOW_API_KEY || "",
});

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
    case "siliconflow":
      return siliconflow(config.modelId);
    case "iflow":
      return iflow(config.modelId);
    default:
      // CLI providers are handled before getModel() is called; this should never be reached
      throw new Error(`Unsupported provider: ${config.provider}`);
  }
}

const AGENT_MAX_STEPS = parseInt(process.env.AGENT_MAX_STEPS || "25", 10);

export interface AgentSession {
  sessionId: string;
  userId: string;
  /** Project this session belongs to (empty string = legacy per-session workspace) */
  projectId: string;
  workspace: string;
  messages: CoreMessage[];
  modelKey: string;
  /** Docker container ID (only set when Docker isolation is enabled) */
  containerId?: string;
  /** Custom project instructions (appended to system prompt) */
  customPrompt?: string;
  /** Timestamp of last activity, used for TTL cleanup */
  lastActivity: number;
}

export async function createSession(
  sessionId: string,
  userId: string,
  projectId: string = ''
): Promise<AgentSession> {
  const workspace = getWorkspaceRoot(sessionId, projectId || undefined);
  await mkdir(workspace, { recursive: true });

  // Try to restore from database
  const saved = getSession(sessionId);
  if (saved && saved.userId === userId) {
    return {
      sessionId,
      userId,
      projectId: saved.projectId || projectId,
      workspace,
      messages: saved.messages,
      modelKey: saved.modelKey,
      lastActivity: Date.now(),
    };
  }

  return {
    sessionId,
    userId,
    projectId,
    workspace,
    messages: [],
    modelKey: "deepseek-v4-flash",
    lastActivity: Date.now(),
  };
}

export interface ImageData {
  base64: string;
  mimeType: string;
}

export async function runAgent(
  session: AgentSession,
  userMessage: string,
  onEvent: (event: AgentEventType) => void,
  signal?: AbortSignal,
  images?: ImageData[]
): Promise<void> {
  // ── CLI routing: 注册表命中即委托本机 CLI 工具 ──
  const cliAdapter = cliAdapters[session.modelKey];
  if (cliAdapter) {
    session.messages.push({ role: "user", content: userMessage });
    await runCliSession(cliAdapter, session, userMessage, onEvent, signal);
    saveSession(session.sessionId, session.userId, session.messages, session.modelKey, session.projectId);
    return;
  }

  // Smart model routing: auto-select model based on prompt complexity
  let effectiveModelKey = session.modelKey;
  if (session.modelKey === "auto") {
    const analysis = analyzePrompt(userMessage, session.messages, !!images?.length);
    effectiveModelKey = analysis.suggestedModel;
    onEvent({ type: "model-selected", modelKey: effectiveModelKey, reason: analysis.reason });
    console.log(`[Router] auto → ${effectiveModelKey} (${analysis.reason})`);
  }

  console.log(`[Agent] model=${effectiveModelKey}, message="${userMessage.slice(0, 80)}"`);

  const history = fromLegacyAiSdkMessages(session.messages);

  try {
    const { messages } = await runAgentLoop({
      modelClient: createNodeModelClient(effectiveModelKey),
      backend: createNodeBackend(session.workspace, session.containerId),
      workspace: session.workspace,
      system: buildSystemPrompt({ customPrompt: session.customPrompt }),
      history,
      userMessage,
      images,
      onEvent,
      signal,
      maxSteps: AGENT_MAX_STEPS,
    });

    // loop 返回的 messages 已含本轮 user 消息;此后持久化即 CoreMessage 格式。
    session.messages = messages;

    // Persist to database
    saveSession(session.sessionId, session.userId, session.messages, session.modelKey, session.projectId);

    onEvent({ type: "done" });
  } catch (err: any) {
    console.error("[Agent] Error:", err.message);
    // loop 抛出前已发 error 事件,但未返回 messages。这里保留 loop 前的历史 + 本轮 user 消息,
    // 尽力保留语境(旧行为同样只落盘到出错前的最后一次成功状态)。
    const userContent =
      images && images.length > 0
        ? [{ type: "text" as const, text: userMessage }, ...images.map((img) => ({ type: "image" as const, ...img }))]
        : userMessage;
    session.messages = [...history, { role: "user", content: userContent }];
    saveSession(session.sessionId, session.userId, session.messages, session.modelKey, session.projectId);
    onEvent({ type: "done" });
  }
}
