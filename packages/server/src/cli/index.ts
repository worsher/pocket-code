// ── CLI 适配器注册表 ───────────────────────────────────────
import type { CliAgentAdapter } from "./types.js";
import { claudeCodeAdapter } from "./claudeCode.js";
import { codexAdapter } from "./codex.js";
import { geminiAdapter } from "./gemini.js";
import type { AgentEventType } from "@pocket-code/wire";
import type { AgentSession } from "../agent.js";
import { runCliAgent, type SpawnFn } from "./runner.js";

export type { CliAgentAdapter, CliSpawnContext, CliSpawnSpec } from "./types.js";
export { claudeCodeAdapter } from "./claudeCode.js";
export { codexAdapter } from "./codex.js";
export { geminiAdapter } from "./gemini.js";

/** 按 id 索引的可用适配器。已接入 claude-code/codex/gemini-cli。 */
export const cliAdapters: Record<string, CliAgentAdapter> = {
  [claudeCodeAdapter.id]: claudeCodeAdapter,
  [codexAdapter.id]: codexAdapter,
  [geminiAdapter.id]: geminiAdapter,
};

const HISTORY_TURNS = 6;
const HISTORY_CHAR_CAP = 500;

/** codex/gemini 无 resume:把近 N 轮历史摘要注入 userMessage 前缀。
 *  session.messages 是 `ai` SDK 的 CoreMessage[](content 为 string | Array),
 *  故用 typeof 分流;所有 role variant 都有 content 字段,tool-role 也安全。
 *  【关键 off-by-one】agent.ts 在调 runCliSession 之前已 push 本轮 user 消息,
 *  故排除最后一条(本轮 user,它就是 userMessage 本身)再取近 N 轮。 */
function injectHistory(session: AgentSession, userMessage: string): string {
  const recent = session.messages.slice(0, -1).slice(-HISTORY_TURNS * 2);
  if (recent.length === 0) return userMessage;
  const lines = recent.map((m) => {
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    return `${m.role}: ${text.slice(0, HISTORY_CHAR_CAP)}`;
  });
  return `## Recent conversation\n${lines.join("\n")}\n\n## Current request\n${userMessage}`;
}

/** 通用 CLI 会话包装:运行适配器,结束后把 assistant 全文写入会话历史。
 *  claude(supportsResume:true):携带上轮捕获的 session_id 走 --resume,不注入历史摘要。
 *  codex/gemini(supportsResume:false):无原生续接,注入近 6 轮历史摘要到 userMessage。 */
export async function runCliSession(
  adapter: CliAgentAdapter,
  session: AgentSession,
  userMessage: string,
  onEvent: (ev: AgentEventType) => void,
  signal?: AbortSignal,
  spawnFn?: SpawnFn
): Promise<void> {
  const effectiveMessage = adapter.supportsResume ? userMessage : injectHistory(session, userMessage);
  const resumeSessionId = adapter.supportsResume ? session.cliSessions?.[adapter.id] : undefined;
  console.log(`[CLI] ${adapter.id}: workspace=${session.workspace}, resume=${resumeSessionId ?? "none"}, msg="${userMessage.slice(0, 80)}"`);
  const { fullText, cliSessionId } = await runCliAgent(
    adapter,
    effectiveMessage,
    { workspace: session.workspace, customPrompt: session.customPrompt, resumeSessionId },
    onEvent,
    signal,
    spawnFn
  );
  if (cliSessionId) {
    session.cliSessions = { ...(session.cliSessions ?? {}), [adapter.id]: cliSessionId };
  }
  session.messages.push({ role: "assistant", content: fullText || `(${adapter.id} completed)` });
}
