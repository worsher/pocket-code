import "dotenv/config";
import { streamText, type CoreMessage } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { google } from "@ai-sdk/google";
import { createTools, getWorkspaceRoot } from "./tools.js";
import { mkdir } from "fs/promises";
import { saveSession, getSession } from "./db.js";
import { analyzePrompt } from "./modelRouter.js";
import { cliAdapters, runCliSession } from "./cli/index.js";
import type { AgentEventType } from "@pocket-code/wire";
import { mapAiSdkPart, type AiStreamPartLike } from "./aiSdkEvents.js";

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

const SYSTEM_PROMPT = `You are Pocket Code, an AI coding assistant running on a mobile device. You help developers write, debug, and manage code through natural conversation.

You have access to a workspace directory where you can read/write files and execute commands. Use the tools provided to help the user.

Guidelines:
- Be concise in your responses (mobile screen is small)
- When modifying files, always read them first to understand the context
- After making changes, verify by reading the file or running relevant commands
- Use markdown for code blocks with language tags
- When executing commands, explain what you're doing briefly
- If a command fails, try to diagnose and fix the issue`;

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

  // Build user message — multi-modal if images are present
  if (images?.length) {
    const content: Array<{ type: string; text?: string; image?: Uint8Array; mimeType?: string }> = [
      { type: "text", text: userMessage },
    ];
    for (const img of images) {
      content.push({
        type: "image",
        image: new Uint8Array(Buffer.from(img.base64, "base64")),
        mimeType: img.mimeType,
      });
    }
    session.messages.push({ role: "user", content: content as any });
  } else {
    session.messages.push({ role: "user", content: userMessage });
  }

  // Smart model routing: auto-select model based on prompt complexity
  let effectiveModelKey = session.modelKey;
  if (session.modelKey === "auto") {
    const analysis = analyzePrompt(userMessage, session.messages, !!images?.length);
    effectiveModelKey = analysis.suggestedModel;
    onEvent({ type: "model-selected", modelKey: effectiveModelKey, reason: analysis.reason });
    console.log(`[Router] auto → ${effectiveModelKey} (${analysis.reason})`);
  }

  const tools = createTools(session.workspace, session.containerId);
  const model = getModel(effectiveModelKey);

  // Append custom project instructions if present
  let systemPrompt = SYSTEM_PROMPT;
  if (session.customPrompt?.trim()) {
    systemPrompt += `\n\n## Project Instructions\n${session.customPrompt.trim()}`;
  }

  console.log(`[Agent] model=${effectiveModelKey}, message="${userMessage.slice(0, 80)}"`);

  const maxSteps = parseInt(process.env.AGENT_MAX_STEPS || "25", 10);

  try {
    const result = streamText({
      model,
      system: systemPrompt,
      messages: session.messages,
      tools,
      maxSteps,
      abortSignal: signal,
    });

    let fullText = "";

    for await (const part of result.fullStream) {
      if (part.type === "text-delta") fullText += part.textDelta;
      for (const ev of mapAiSdkPart(part as AiStreamPartLike)) onEvent(ev);
    }

    // Use the SDK's response messages which include tool calls and results,
    // preserving full context for subsequent conversation turns.
    const responseMessages = (await result.response).messages;
    if (responseMessages.length > 0) {
      session.messages.push(...responseMessages);
    } else {
      // Fallback: save at least the text content
      session.messages.push({ role: "assistant", content: fullText });
    }

    // Persist to database
    saveSession(session.sessionId, session.userId, session.messages, session.modelKey, session.projectId);

    // Emit token usage stats
    try {
      const usage = await result.usage;
      if (usage) {
        onEvent({
          type: "usage",
          inputTokens: usage.promptTokens || 0,
          outputTokens: usage.completionTokens || 0,
        });
      }
    } catch {
      // Usage data not available — ignore
    }

    onEvent({ type: "done" });
  } catch (err: any) {
    console.error("[Agent] Error:", err.message);
    // Still persist what we have
    saveSession(session.sessionId, session.userId, session.messages, session.modelKey, session.projectId);
    onEvent({ type: "error", message: err.message });
    onEvent({ type: "done" });
  }
}
