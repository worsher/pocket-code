// ── RnModelClient ──────────────────────────────────────
// P9 Task 9: 把 App 现有 aiClient 的 callbacks 风格 SSE 流适配成
// agent-core ModelClient 的 AsyncIterable 风格,供后续 App 侧接入
// 同构 agent 循环(runAgentLoop)使用。
//
// tools 参数接线留给 T10(aiClient.streamChatOpenAI 目前用全局
// TOOL_DEFINITIONS,尚未开放为参数)。

import type { CoreMessage, ModelClient, ModelDelta, ToolSchema } from "@pocket-code/agent-core";
import { streamChat, type ChatMessage, type ContentPart as AiContentPart, type ToolCallRequest } from "./aiClient";
import type { ModelConfig } from "./modelConfig";
import type { AppSettings } from "../store/settings";

// ── 队列桥接器:callbacks → AsyncIterable ───────────────

/**
 * 把"注册 onDelta/onDone/onError 回调,立即开始产生数据"的启动函数
 * 包装成 AsyncIterable<ModelDelta>。
 *
 * 实现:内部数组队列 + pending resolver。onDelta 入队并唤醒等待中的
 * next();onDone 标记终结(队列排空后返回 done);onError 让下一次
 * next() 抛出(通过 reject 一个 pending promise)。
 */
export function callbacksToAsyncIterable(
  start: (cb: {
    onDelta: (d: ModelDelta) => void;
    onDone: () => void;
    onError: (msg: string) => void;
  }) => void
): AsyncIterable<ModelDelta> {
  const queue: ModelDelta[] = [];
  let done = false;
  let error: string | undefined;
  // 等待中的 next() 调用:队列为空且未终结时,next() 挂起在这里,
  // 由 onDelta/onDone/onError 唤醒。
  let pendingResolve: (() => void) | undefined;

  const wake = () => {
    if (pendingResolve) {
      const r = pendingResolve;
      pendingResolve = undefined;
      r();
    }
  };

  start({
    onDelta: (d) => {
      queue.push(d);
      wake();
    },
    onDone: () => {
      done = true;
      wake();
    },
    onError: (msg) => {
      error = msg;
      done = true;
      wake();
    },
  });

  return {
    [Symbol.asyncIterator](): AsyncIterator<ModelDelta> {
      return {
        async next(): Promise<IteratorResult<ModelDelta>> {
          // 队列有数据就先吐出来,即便已经 done/error(不丢已产生的 delta)。
          while (queue.length === 0 && !done) {
            await new Promise<void>((resolve) => {
              pendingResolve = resolve;
            });
          }
          if (queue.length > 0) {
            const value = queue.shift()!;
            return { value, done: false };
          }
          if (error !== undefined) {
            throw new Error(error);
          }
          return { value: undefined as any, done: true };
        },
      };
    },
  };
}

// ── 消息转换:CoreMessage(agent-core) → ChatMessage(aiClient) ──
// 语义对照被删除的 geekLoop.buildChatHistory(方向相反:那边是
// Message[](App UI 消息)→ ChatMessage[];这里是 CoreMessage[]
// (agent-core 同构消息)→ ChatMessage[])。

function toAiContentParts(parts: import("@pocket-code/agent-core").ContentPart[]): AiContentPart[] {
  return parts.map((p) => {
    if (p.type === "image") {
      return {
        type: "image_url" as const,
        image_url: { url: `data:${p.mimeType};base64,${p.base64}` },
      };
    }
    return { type: "text" as const, text: p.text };
  });
}

export function toChatMessages(messages: CoreMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    switch (m.role) {
      case "system":
        out.push({ role: "system", content: m.content });
        break;
      case "user":
        out.push({
          role: "user",
          content: typeof m.content === "string" ? m.content : toAiContentParts(m.content),
        });
        break;
      case "assistant": {
        if (m.toolCalls?.length) {
          const tool_calls: ToolCallRequest[] = m.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          }));
          out.push({ role: "assistant", content: m.content, tool_calls });
        } else {
          out.push({ role: "assistant", content: m.content });
        }
        break;
      }
      case "tool":
        out.push({ role: "tool", content: m.content, tool_call_id: m.toolCallId });
        break;
    }
  }
  return out;
}

// ── ModelClient 工厂 ────────────────────────────────────

export function createRnModelClient(cfg: {
  modelConfig: ModelConfig;
  apiKey: string;
  settings: AppSettings;
  customPrompt?: string;
}): ModelClient {
  const { modelConfig, apiKey, settings, customPrompt } = cfg;

  return {
    streamStep(req: {
      system: string;
      messages: CoreMessage[];
      tools: ToolSchema[];
      signal?: AbortSignal;
    }): AsyncIterable<ModelDelta> {
      const messages = toChatMessages(req.messages);

      return callbacksToAsyncIterable(({ onDelta, onDone, onError }) => {
        // tools 接线留给 T10(aiClient.streamChatOpenAI 目前内部用全局
        // TOOL_DEFINITIONS,尚不接受 tools 参数)。req.tools 暂不使用。
        // req.system 同理:aiClient 未暴露"直接使用完整 system 字符串"的
        // 入口(buildSystemPrompt 未导出,streamChat 内部总会拿 customPrompt
        // 重新拼装 system),故 system 拼装暂沿用 cfg.customPrompt,由
        // aiClient 侧的 buildSystemPrompt 组装;req.system 本身不使用。
        void streamChat({
          model: modelConfig,
          apiKey,
          messages,
          signal: req.signal,
          settings,
          customPrompt,
          callbacks: {
            onTextDelta: (text) => onDelta({ type: "text", text }),
            onThinking: (text) => onDelta({ type: "reasoning", text }),
            onToolCall: (id, name, args) => onDelta({ type: "tool-call", id, name, args }),
            onDone,
            onError,
          },
        }).catch((err) => onError(err instanceof Error ? err.message : String(err)));
      });
    },
  };
}
