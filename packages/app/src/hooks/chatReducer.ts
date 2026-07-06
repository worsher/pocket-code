// ── 归一化 AgentEvent → 消息列表 reducer(纯函数,零 RN 依赖) ──
// P6b:云端与 geek 两条路径共用的 UI 更新逻辑。只更新末尾 assistant
// 消息;无变化时返回原引用(避免无谓渲染)。phase 推导同理。

import type { AgentEventType } from "@pocket-code/wire";
import type { StreamingPhase } from "../components/StreamingIndicator";
import type { CoreMessage } from "@pocket-code/agent-core";

export interface ImageAttachment {
  uri: string;
  base64: string;
  mimeType: "image/jpeg" | "image/png";
}

export interface ToolCall {
  /** 归一化事件的 callId;历史旧存档无此字段 */
  callId?: string;
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  images?: ImageAttachment[];
  timestamp: number;
  pending?: boolean;
  modelUsed?: string;
}

/** 更新末尾 assistant 消息;末尾不是 assistant 则原样返回。 */
function updateLastAssistant(
  messages: Message[],
  update: (m: Message) => Message
): Message[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return messages;
  const updated = update(last);
  // 若 update 返回原引用(无变化),直接返回原数组
  if (updated === last) return messages;
  const next = messages.slice(0, -1);
  next.push(updated);
  return next;
}

export function applyAgentEvent(messages: Message[], ev: AgentEventType): Message[] {
  switch (ev.type) {
    case "text-delta":
      return updateLastAssistant(messages, (m) => ({ ...m, content: m.content + ev.text }));
    case "reasoning-delta":
      return updateLastAssistant(messages, (m) => ({ ...m, thinking: (m.thinking || "") + ev.text }));
    case "tool-call":
      return updateLastAssistant(messages, (m) => ({
        ...m,
        toolCalls: [...(m.toolCalls || []), { callId: ev.callId, toolName: ev.name, args: ev.args }],
      }));
    case "tool-result":
      return updateLastAssistant(messages, (m) => {
        const toolCalls = [...(m.toolCalls || [])];
        // callId 精确配对;找不到再回退"首个未完成"(兼容合成/缺失 callId)
        let idx = toolCalls.findIndex((t) => t.callId === ev.callId && t.result === undefined);
        if (idx === -1) idx = toolCalls.findIndex((t) => t.result === undefined);
        if (idx === -1) return m;
        toolCalls[idx] = { ...toolCalls[idx], result: ev.result };
        return { ...m, toolCalls };
      });
    case "model-selected":
      return updateLastAssistant(messages, (m) => ({ ...m, modelUsed: ev.modelKey }));
    case "error":
      return updateLastAssistant(messages, (m) => ({ ...m, content: m.content + `\n\nError: ${ev.message}` }));
    // usage/done/file-changed/command-output/process-*/preview-available:
    // 无消息列表内的 UI 消费者(done 的副作用在 hook 层),显式忽略。
    default:
      return messages;
  }
}

/**
 * editAndResend(geek 模式)截断 UI messages 到编辑点之前后,coreHistoryRef
 * (与 UI messages 并行维护的 CoreMessage 史)也要同步截断,否则重发时仍会
 * 把已被"分支丢弃"的旧轮次带给模型。
 *
 * UI Message[] 与 CoreMessage[] 不是 1:1 的(一轮 user 消息在 CoreMessage 里
 * 对应 1 条 user + N 条 assistant(每 step 一条)+ N 条 tool),所以不能直接按
 * 下标截断——而是按"保留的 user 轮次数"对齐:keepUserTurns = truncated 后的
 * UI messages 里 role==="user" 的条数;在 CoreMessage[] 里保留到第
 * (keepUserTurns+1) 条 user 消息之前(不含)。
 */
export function truncateCoreHistory(history: CoreMessage[], keepUserTurns: number): CoreMessage[] {
  if (keepUserTurns <= 0) return [];
  let seen = 0;
  for (let i = 0; i < history.length; i++) {
    if (history[i].role === "user") {
      seen++;
      if (seen > keepUserTurns) return history.slice(0, i);
    }
  }
  return history.slice();
}

/** 事件 → streaming phase;null 表示不改变当前 phase。 */
export function phaseFor(ev: AgentEventType): StreamingPhase | null {
  switch (ev.type) {
    case "reasoning-delta":
      return "thinking";
    case "text-delta":
      return "generating";
    case "tool-call":
      return "tool-calling";
    case "tool-result":
      return "generating";
    case "done":
    case "error":
      return "idle";
    default:
      return null;
  }
}
