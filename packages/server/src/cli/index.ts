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

/** 通用 CLI 会话包装:运行适配器,结束后把 assistant 全文写入会话历史。 */
export async function runCliSession(
  adapter: CliAgentAdapter,
  session: AgentSession,
  userMessage: string,
  onEvent: (ev: AgentEventType) => void,
  signal?: AbortSignal,
  spawnFn?: SpawnFn
): Promise<void> {
  console.log(`[CLI] ${adapter.id}: workspace=${session.workspace}, msg="${userMessage.slice(0, 80)}"`);
  // 注:runCliAgent 现返回 { fullText, cliSessionId }(T6)。这里仅解构出 fullText 维持既有行为;
  // cliSessionId 的持久化/--resume 接线属于 T7 范围,故意不在此处理。
  const { fullText } = await runCliAgent(
    adapter,
    userMessage,
    { workspace: session.workspace, customPrompt: session.customPrompt },
    onEvent,
    signal,
    spawnFn
  );
  session.messages.push({ role: "assistant", content: fullText || `(${adapter.id} completed)` });
}
