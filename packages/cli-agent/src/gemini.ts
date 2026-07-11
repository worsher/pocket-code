// ── gemini-cli 适配器 ───────────────────────────────────────
// spawn 参数与 stream-json 解析等价迁移自旧版内联 CLI runner(P8 后已删除)。
// 与旧路径唯一有意差异:customPrompt 非空时拼为消息前缀(旧路径丢弃)。

import type { CliAgentAdapter, CliSpawnContext, CliSpawnSpec, CliEvent } from "./types.js";

/** gemini stream-json 行结构(NDJSON) */
interface GeminiStreamLine {
  type: "init" | "message" | "tool_use" | "tool_result" | "result" | "error";
  session_id?: string;
  model?: string;
  role?: "user" | "assistant";
  content?: string;
  tool_name?: string;
  tool_id?: string;
  parameters?: unknown;
  status?: "success" | "error";
  output?: unknown;
  error?: { type?: string; message?: string } | string;
}

export const geminiAdapter = {
  id: "gemini-cli",
  supportsResume: false,

  buildSpawn(userMessage: string, ctx: CliSpawnContext): CliSpawnSpec {
    const message = ctx.customPrompt?.trim()
      ? `## Project Instructions\n${ctx.customPrompt.trim()}\n\n${userMessage}`
      : userMessage;

    const args = [
      "--prompt", message,
      "--output-format", "stream-json",
      "--yolo",
    ];
    const geminiModel = process.env.GEMINI_CLI_MODEL;
    if (geminiModel) args.push("--model", geminiModel);
    // 默认不加载用户全局扩展,避免 chrome-devtools 等挂起;
    // 传不存在的名称 = 跳过所有扩展加载。
    const extensions = process.env.GEMINI_CLI_EXTENSIONS?.split(",").filter(Boolean) ?? [];
    args.push("--extensions", ...(extensions.length > 0 ? extensions : ["__none__"]));

    // 清除 GCP 项目变量,避免干扰 gemini CLI 的项目选择
    const env = { ...process.env };
    delete env.GOOGLE_CLOUD_PROJECT;
    delete env.GCLOUD_PROJECT;

    return {
      cmd: process.env.GEMINI_CLI_PATH || "gemini",
      args,
      env,
      cwd: ctx.workspace,
    };
  },

  createParser(): (line: string) => CliEvent[] {
    let synthCount = 0;
    return (line: string): CliEvent[] => {
      const trimmed = line.trim();
      if (!trimmed) return [];
      let evt: GeminiStreamLine;
      try {
        evt = JSON.parse(trimmed);
      } catch {
        return []; // 非 JSON 行(ANSI 等)忽略
      }
      if (!evt || typeof evt !== "object") return [];
      switch (evt.type) {
        case "init":
          console.log(`[CLI] Gemini session=${evt.session_id}, model=${evt.model}`);
          return [];
        case "message":
          return evt.role === "assistant" && evt.content
            ? [{ type: "text-delta", text: evt.content }]
            : [];
        case "tool_use":
          return evt.tool_name
            ? [{
                type: "tool-call",
                callId: evt.tool_id ?? `gm_${++synthCount}`,
                name: evt.tool_name,
                args: (evt.parameters as Record<string, unknown>) ?? {},
              }]
            : [];
        case "tool_result":
          return [{
            type: "tool-result",
            callId: evt.tool_id ?? `gm_${synthCount}`,
            result: evt.output ?? {},
            ...(evt.status === "error" ? { isError: true } : {}),
          }];
        case "result":
          if (evt.status === "error" && evt.error) {
            const msg = typeof evt.error === "string" ? evt.error : (evt.error.message ?? "Gemini CLI 执行失败");
            return [{ type: "error", message: msg }];
          }
          return [];
        case "error":
          return [{
            type: "error",
            message: typeof evt.error === "string" ? evt.error : "Gemini CLI 未知错误",
          }];
        default:
          return [];
      }
    };
  },
} satisfies CliAgentAdapter;
