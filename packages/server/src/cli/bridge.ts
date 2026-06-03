// ── AgentEvent → 旧 StreamEvent 桥接(灰度) ──────────────────
// P3b 让 CLI 路径内部产出归一化 AgentEvent,但 messageHandler/App 仍消费
// 旧 StreamEvent。此转换器做字段映射;并记忆 tool-call 的 callId→name,
// 以便 tool-result 携带真实 toolName(旧解析里曾是占位 "_claude_tool")。
// App 迁移到原生消费 AgentEvent 后(后续计划)可移除本桥接。

import type { AgentEventType } from "@pocket-code/wire";
import type { StreamEvent } from "../agent.js";

export function createAgentEventToStreamEvent(): (ev: AgentEventType) => StreamEvent | null {
  const callNames = new Map<string, string>();

  return (ev: AgentEventType): StreamEvent | null => {
    switch (ev.type) {
      case "text-delta":
        return { type: "text-delta", text: ev.text };
      case "reasoning-delta":
        return { type: "reasoning-delta", text: ev.text };
      case "tool-call":
        if (ev.callId) callNames.set(ev.callId, ev.name);
        return { type: "tool-call", toolName: ev.name, args: ev.args };
      case "tool-result":
        return {
          type: "tool-result",
          toolName: callNames.get(ev.callId) ?? "",
          result: ev.result,
        };
      case "usage":
        return {
          type: "usage",
          promptTokens: ev.inputTokens,
          completionTokens: ev.outputTokens,
          totalTokens: ev.inputTokens + ev.outputTokens,
        };
      case "error":
        return { type: "error", error: ev.message };
      case "model-selected":
        return { type: "model-selected", model: ev.modelKey, reason: ev.reason ?? "" };
      case "file-changed":
        return { type: "file-changed", path: ev.path, action: ev.changeType };
      case "done":
        return { type: "done" };
      // command-output / process-started / process-exited / preview-available
      // 在旧 StreamEvent 中无对应,灰度期丢弃(App 迁移后原生消费)。
      default:
        return null;
    }
  };
}
