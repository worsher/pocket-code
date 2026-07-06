// ── AI-SDK fullStream part → 归一化 AgentEvent ──────────────
// P6b:agent.ts 的 AI-SDK 路径改产 wire AgentEvent,映射逻辑抽成
// 纯函数便于单测。结构化最小类型,不绑 ai 包的泛型。

import type { AgentEventType } from "@pocket-code/wire";

export interface AiStreamPartLike {
  type: string;
  textDelta?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  error?: unknown;
}

export function mapAiSdkPart(part: AiStreamPartLike): AgentEventType[] {
  switch (part.type) {
    case "text-delta":
      return [{ type: "text-delta", text: part.textDelta ?? "" }];
    case "reasoning":
      return [{ type: "reasoning-delta", text: part.textDelta ?? "" }];
    case "tool-call":
      return [
        {
          type: "tool-call",
          callId: part.toolCallId ?? "",
          name: part.toolName ?? "",
          args: (part.args as Record<string, unknown>) ?? {},
        },
      ];
    case "tool-result": {
      const events: AgentEventType[] = [
        { type: "tool-result", callId: part.toolCallId ?? "", result: part.result },
      ];
      // writeFile/editFile 成功 → 派生 file-changed(驱动 App Diff/本地同步)
      const r = part.result as { success?: boolean; path?: string; isNew?: boolean } | undefined;
      if ((part.toolName === "writeFile" || part.toolName === "editFile") && r?.success && r.path) {
        events.push({ type: "file-changed", path: r.path, changeType: r.isNew ? "created" : "modified" });
      }
      return events;
    }
    case "error":
      return [{ type: "error", message: String(part.error) }];
    default:
      return [];
  }
}
