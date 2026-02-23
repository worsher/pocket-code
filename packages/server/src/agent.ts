import "dotenv/config";
import { streamText, type CoreMessage } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { google } from "@ai-sdk/google";
import { createTools, getWorkspaceRoot } from "./tools.js";
import { mkdir } from "fs/promises";
import { saveSession, getSession } from "./db.js";
import { analyzePrompt } from "./modelRouter.js";

export type ModelProvider = "anthropic" | "openai" | "google" | "siliconflow";

interface ModelConfig {
  provider: ModelProvider;
  modelId: string;
}

/**
 * Supported models:
 * - claude-sonnet / claude-haiku: Anthropic Claude
 * - gpt-4o / gpt-4o-mini: OpenAI
 * - gemini-flash: Google Gemini
 * - deepseek-v3 / deepseek-r1: DeepSeek via SiliconFlow (硅基流动)
 * - qwen-coder: Qwen via SiliconFlow
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
  "deepseek-v3": { provider: "siliconflow", modelId: "deepseek-ai/DeepSeek-V3" },
  "deepseek-r1": { provider: "siliconflow", modelId: "deepseek-ai/DeepSeek-R1" },
  "qwen-coder": { provider: "siliconflow", modelId: "Qwen/Qwen2.5-Coder-32B-Instruct" },
};

/** SiliconFlow uses OpenAI-compatible API */
const siliconflow = createOpenAI({
  baseURL: process.env.SILICONFLOW_BASE_URL || "https://api.siliconflow.cn/v1",
  apiKey: process.env.SILICONFLOW_API_KEY || "",
});

/** Standard OpenAI */
const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY || "",
});

function getModel(modelKey: string) {
  const config = MODEL_MAP[modelKey] || MODEL_MAP["deepseek-v3"];
  switch (config.provider) {
    case "anthropic":
      return anthropic(config.modelId);
    case "openai":
      return openai(config.modelId);
    case "google":
      return google(config.modelId);
    case "siliconflow":
      return siliconflow(config.modelId);
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
    };
  }

  return {
    sessionId,
    userId,
    projectId,
    workspace,
    messages: [],
    modelKey: "deepseek-v3",
  };
}

export type StreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "model-selected"; model: string; reason: string }
  | { type: "tool-call"; toolName: string; args: unknown }
  | { type: "tool-result"; toolName: string; result: unknown }
  | { type: "error"; error: string }
  | { type: "done" };

export interface ImageData {
  base64: string;
  mimeType: string;
}

export async function runAgent(
  session: AgentSession,
  userMessage: string,
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal,
  images?: ImageData[]
): Promise<void> {
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
    onEvent({ type: "model-selected", model: effectiveModelKey, reason: analysis.reason });
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

  try {
    const result = streamText({
      model,
      system: systemPrompt,
      messages: session.messages,
      tools,
      maxSteps: 10,
      abortSignal: signal,
    });

    let fullText = "";

    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta":
          fullText += part.textDelta;
          onEvent({ type: "text-delta", text: part.textDelta });
          break;

        case "reasoning":
          onEvent({ type: "reasoning-delta", text: (part as any).textDelta || "" });
          break;

        case "tool-call":
          onEvent({ type: "tool-call", toolName: part.toolName, args: part.args });
          break;

        case "tool-result":
          onEvent({ type: "tool-result", toolName: part.toolName, result: part.result });
          break;

        case "error":
          onEvent({ type: "error", error: String(part.error) });
          break;
      }
    }

    session.messages.push({ role: "assistant", content: fullText });

    // Persist to database
    saveSession(session.sessionId, session.userId, session.messages, session.modelKey, session.projectId);

    onEvent({ type: "done" });
  } catch (err: any) {
    console.error("[Agent] Error:", err.message);
    // Still persist what we have
    saveSession(session.sessionId, session.userId, session.messages, session.modelKey, session.projectId);
    onEvent({ type: "error", error: err.message });
    onEvent({ type: "done" });
  }
}
