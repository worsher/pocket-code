// ── CLI 适配器注册表 ───────────────────────────────────────
import type { CliAgentAdapter } from "./types.js";
import { claudeCodeAdapter } from "./claudeCode.js";

export type { CliAgentAdapter, CliSpawnContext, CliSpawnSpec } from "./types.js";
export { claudeCodeAdapter } from "./claudeCode.js";

/** 按 id 索引的可用适配器。P3a 仅 claude-code;codex/gemini-cli 后续接入。 */
export const cliAdapters: Record<string, CliAgentAdapter> = {
  [claudeCodeAdapter.id]: claudeCodeAdapter,
};
