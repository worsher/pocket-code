// ── codex 适配器 ────────────────────────────────────────────
// codex exec --json 的 JSONL 事件流 → 归一化 AgentEvent。
// fixture 依据:2026-07-06 真机 codex-cli 0.142.5(见 P8 计划背景事实)。
// env 不清理:codex 认自己的 ~/.codex/config.toml(镜像/模型为用户主动配置),
// 与 claude 适配器"清 ANTHROPIC_*"策略相反且有意。

import type { AgentEventType } from "@pocket-code/wire";
import type { CliAgentAdapter, CliSpawnContext, CliSpawnSpec } from "./types.js";

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
  changes?: Array<{ path?: string; kind?: string }>;
  server?: string;
  tool?: string;
}

interface CodexLine {
  type?: string;
  item?: CodexItem;
  usage?: { input_tokens?: number; output_tokens?: number };
  message?: string;
  error?: { message?: string };
}

const KIND_TO_CHANGE: Record<string, "created" | "modified" | "deleted"> = {
  add: "created",
  update: "modified",
  delete: "deleted",
};

export const codexAdapter = {
  id: "codex",
  supportsResume: false,

  buildSpawn(userMessage: string, ctx: CliSpawnContext): CliSpawnSpec {
    const message = ctx.customPrompt?.trim()
      ? `## Project Instructions\n${ctx.customPrompt.trim()}\n\n${userMessage}`
      : userMessage;
    return {
      cmd: process.env.CODEX_CLI_PATH || "codex",
      args: [
        "exec", "--json",
        // workspace 可能不是 git 仓库/不在 codex 信任列表
        "--skip-git-repo-check",
        // 与 claude 路径 --dangerously-skip-permissions 同级信任(个人工具)
        "--dangerously-bypass-approvals-and-sandbox",
        message,
      ],
      env: { ...process.env },
      cwd: ctx.workspace,
    };
  },

  parseLine(line: string): AgentEventType[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let evt: CodexLine;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      return [];
    }
    if (!evt || typeof evt !== "object") return [];

    switch (evt.type) {
      case "item.started": {
        const item = evt.item;
        if (!item?.id) return [];
        if (item.type === "command_execution") {
          return [{
            type: "tool-call", callId: item.id, name: "runCommand",
            args: { command: item.command ?? "" },
          }];
        }
        if (item.type === "mcp_tool_call") {
          return [{
            type: "tool-call", callId: item.id,
            name: `${item.server ?? "mcp"}.${item.tool ?? "tool"}`,
            args: {},
          }];
        }
        return [];
      }

      case "item.completed": {
        const item = evt.item;
        if (!item) return [];
        switch (item.type) {
          case "agent_message":
            return item.text ? [{ type: "text-delta", text: item.text }] : [];
          case "reasoning":
            return item.text ? [{ type: "reasoning-delta", text: item.text }] : [];
          case "command_execution": {
            if (!item.id) return [];
            const exitCode = item.exit_code ?? 0;
            return [{
              type: "tool-result", callId: item.id,
              result: { output: item.aggregated_output ?? "", exitCode },
              ...(exitCode !== 0 ? { isError: true } : {}),
            }];
          }
          case "file_change": {
            const events: AgentEventType[] = [];
            for (const c of item.changes ?? []) {
              const changeType = KIND_TO_CHANGE[c.kind ?? ""];
              if (c.path && changeType) {
                events.push({ type: "file-changed", path: c.path, changeType });
              }
            }
            return events;
          }
          case "mcp_tool_call":
            return item.id
              ? [{ type: "tool-result", callId: item.id, result: item }]
              : [];
          default:
            return []; // todo_list/web_search 等:无 UI 消费者
        }
      }

      case "turn.completed": {
        const u = evt.usage;
        return u
          ? [{ type: "usage", inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0 }]
          : [];
      }

      case "error":
        return evt.message ? [{ type: "error", message: evt.message }] : [];

      case "turn.failed":
        return [{ type: "error", message: evt.error?.message ?? "codex turn failed" }];

      // thread.started / turn.started / item.updated(增量,按完整消息出 text 的既有取舍) 等忽略
      default:
        return [];
    }
  },
} satisfies CliAgentAdapter;
