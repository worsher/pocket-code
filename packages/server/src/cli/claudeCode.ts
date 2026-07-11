// ── claude-code 适配器 ─────────────────────────────────────
// 把 claude CLI 的 --output-format stream-json NDJSON 归一化为 AgentEvent。
// 解析形态参考既有 parseClaudeLine 实现(proven 对接真实 claude-code)。

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

export const claudeCodeAdapter = {
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
    if (ctx.resumeSessionId) {
      args.unshift("--resume", ctx.resumeSessionId);
    }
    // claude CLI 使用自身存储的 OAuth 凭证与自身配置的模型;清除宿主 shell
    // 里可能残留的 ANTHROPIC_* 覆盖项(API key/镜像 base URL/模型指定),
    // 否则旧值会劫持 CLI(真机案例:ANTHROPIC_MODEL 指向已下线模型 → 404)。
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_BASE_URL;
    delete env.ANTHROPIC_MODEL;
    delete env.ANTHROPIC_SMALL_FAST_MODEL;
    delete env.ANTHROPIC_DEFAULT_OPUS_MODEL;
    delete env.ANTHROPIC_DEFAULT_SONNET_MODEL;
    delete env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
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
    if (!msg || typeof msg !== "object") return [];

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

  extractSessionId(line: string): string | undefined {
    const t = line.trim();
    if (!t) return undefined;
    try {
      const m = JSON.parse(t);
      if (m?.type === "system" && m?.subtype === "init" && typeof m.session_id === "string") {
        return m.session_id;
      }
    } catch {
      /* 非 JSON 行 */
    }
    return undefined;
  },
} satisfies CliAgentAdapter;
