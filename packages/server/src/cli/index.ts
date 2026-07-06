// ── CLI 适配器注册表 ───────────────────────────────────────
import type { CliAgentAdapter } from "./types.js";
import { claudeCodeAdapter } from "./claudeCode.js";
import { geminiAdapter } from "./gemini.js";

export type { CliAgentAdapter, CliSpawnContext, CliSpawnSpec } from "./types.js";
export { claudeCodeAdapter } from "./claudeCode.js";
export { geminiAdapter } from "./gemini.js";

/** 按 id 索引的可用适配器。已接入 claude-code/gemini-cli;codex 后续接入。 */
export const cliAdapters: Record<string, CliAgentAdapter> = {
  [claudeCodeAdapter.id]: claudeCodeAdapter,
  [geminiAdapter.id]: geminiAdapter,
};
