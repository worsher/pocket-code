// ── CLI 适配器注册表 ───────────────────────────────────────
import type { CliAgentAdapter } from "./types.js";
import { claudeCodeAdapter } from "./claudeCode.js";
import { codexAdapter } from "./codex.js";
import { geminiAdapter } from "./gemini.js";

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
