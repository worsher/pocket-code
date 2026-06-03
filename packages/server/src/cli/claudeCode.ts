// ── claude-code 适配器 ─────────────────────────────────────
// 把 claude CLI 的 --output-format stream-json NDJSON 归一化为 AgentEvent。
// 解析形态参考既有 cliRunner.ts 的 parseClaudeLine(proven 对接真实 claude-code)。

import type { AgentEventType } from "@pocket-code/wire";
import type { CliAgentAdapter, CliSpawnContext, CliSpawnSpec } from "./types.js";

/** 安全转为非负整数,无效值归零。 */
function toCount(v: unknown): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** tool_result.content 可能是字符串或 [{type:"text",text}] 数组,统一取文本。 */
function toolResultText(content: unknown): string {
  if (Array.isArray(content)) {
    return content.map((c: any) => (c?.type === "text" ? String(c.text ?? "") : "")).join("");
  }
  return String(content ?? "");
}

export const claudeCodeAdapter: CliAgentAdapter = {
  id: "claude-code",
  supportsResume: true,

  buildSpawn(userMessage: string, ctx: CliSpawnContext): CliSpawnSpec {
    const args = [
      "-p", userMessage,
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--dangerously-skip-permissions",
    ];
    if (ctx.customPrompt?.trim()) {
      args.push(
        "--append-system-prompt",
        `\n\n## Project Instructions\n${ctx.customPrompt.trim()}`
      );
    }
    // claude CLI 使用自身存储的 OAuth 凭证;清除 API key 避免干扰其认证。
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    return {
      cmd: process.env.CLAUDE_CLI_PATH || "claude",
      args,
      env,
      cwd: ctx.workspace,
    };
  },

  parseLine(line: string): AgentEventType[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let msg: any;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return [];
    }

    const events: AgentEventType[] = [];
    switch (msg?.type) {
      case "assistant": {
        const content = msg.message?.content;
        if (!Array.isArray(content)) break;
        for (const block of content) {
          if (block?.type === "text" && typeof block.text === "string") {
            events.push({ type: "text-delta", text: block.text });
          } else if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.length > 0) {
            events.push({ type: "reasoning-delta", text: block.thinking });
          } else if (block?.type === "tool_use") {
            events.push({
              type: "tool-call",
              callId: typeof block.id === "string" ? block.id : "",
              name: typeof block.name === "string" ? block.name : "",
              args: block.input && typeof block.input === "object" ? block.input : {},
            });
          }
        }
        break;
      }
      case "user": {
        const content = msg.message?.content;
        if (!Array.isArray(content)) break;
        for (const block of content) {
          if (block?.type === "tool_result") {
            events.push({
              type: "tool-result",
              callId: typeof block.tool_use_id === "string" ? block.tool_use_id : "",
              result: toolResultText(block.content),
              isError: block.is_error === true,
            });
          }
        }
        break;
      }
      case "result": {
        if (msg.subtype && msg.subtype !== "success") {
          const errMsg = Array.isArray(msg.errors)
            ? msg.errors.join(", ")
            : String(msg.subtype);
          events.push({ type: "error", message: `Claude Code 执行失败: ${errMsg}` });
        } else if (msg.usage && typeof msg.usage === "object") {
          events.push({
            type: "usage",
            inputTokens: toCount(msg.usage.input_tokens),
            outputTokens: toCount(msg.usage.output_tokens),
          });
        }
        break;
      }
      // "system" / "stream_event" / 其它 → 无业务事件
    }
    return events;
  },
};
