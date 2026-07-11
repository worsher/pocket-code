// ── @pocket-code/cli-agent 入口 ────────────────────────────
// 驱动 claude-code / codex / gemini-cli 子进程,归一化 NDJSON 输出为 CliEvent 流。
import type { CliAgentAdapter } from "./types.js";
import { claudeCodeAdapter } from "./claudeCode.js";
import { codexAdapter } from "./codex.js";
import { geminiAdapter } from "./gemini.js";

export type { CliEvent, CliAgentAdapter, CliSpawnContext, CliSpawnSpec } from "./types.js";
export { isCliEvent } from "./isCliEvent.js";
export { runCliAgent, type SpawnFn } from "./runner.js";
export { killProcessTree, isProcessAlive } from "./processKill.js";
export { claudeCodeAdapter } from "./claudeCode.js";
export { codexAdapter } from "./codex.js";
export { geminiAdapter } from "./gemini.js";

/** 按 id 索引的可用适配器。 */
export const cliAdapters: Record<string, CliAgentAdapter> = {
  [claudeCodeAdapter.id]: claudeCodeAdapter,
  [codexAdapter.id]: codexAdapter,
  [geminiAdapter.id]: geminiAdapter,
};
