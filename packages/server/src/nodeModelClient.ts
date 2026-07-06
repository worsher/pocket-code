// ── NodeModelClient: AI SDK 单步适配 ──────────────────────
// 实现 agent-core 的 ModelClient 接口:streamStep 单步流式输出,
// 浮出 tool calls 但不执行(execute 缺省 → AI SDK 不会自动跑工具,
// 交由上层 agent-core 的 loop 去执行并把结果转回 tool 消息)。

import { streamText, tool, jsonSchema, type CoreMessage as AiCoreMessage } from "ai";
import type { CoreMessage, ModelClient, ModelDelta, ToolSchema } from "@pocket-code/agent-core";
import { getModel } from "./agent.js";

type StreamTextImpl = typeof streamText;

/** core CoreMessage → AI SDK CoreMessage */
function toAiSdkMessage(msg: CoreMessage): AiCoreMessage {
  switch (msg.role) {
    case "system":
      return { role: "system", content: msg.content };
    case "user": {
      if (typeof msg.content === "string") {
        return { role: "user", content: msg.content };
      }
      const parts = msg.content.map((part) => {
        if (part.type === "image") {
          return { type: "image" as const, image: part.base64, mimeType: part.mimeType };
        }
        return { type: "text" as const, text: part.text };
      });
      return { role: "user", content: parts as any };
    }
    case "assistant": {
      if (!msg.toolCalls?.length) {
        return { role: "assistant", content: msg.content };
      }
      const parts: any[] = [];
      if (msg.content) parts.push({ type: "text", text: msg.content });
      for (const tc of msg.toolCalls) {
        parts.push({ type: "tool-call", toolCallId: tc.id, toolName: tc.name, args: tc.args });
      }
      return { role: "assistant", content: parts };
    }
    case "tool": {
      let result: unknown;
      try {
        result = JSON.parse(msg.content);
      } catch {
        result = msg.content;
      }
      return {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: msg.toolCallId, toolName: msg.toolName, result },
        ],
      } as AiCoreMessage;
    }
  }
}

/** core ToolSchema (JSON Schema) → AI SDK tool,不带 execute(client-side,单步浮出) */
function toAiSdkTools(tools: ToolSchema[]): Record<string, ReturnType<typeof tool>> {
  const out: Record<string, ReturnType<typeof tool>> = {};
  for (const t of tools) {
    out[t.name] = tool({
      description: t.description,
      parameters: jsonSchema(t.parameters),
    });
  }
  return out;
}

export function createNodeModelClient(
  modelKey: string,
  streamTextImpl: StreamTextImpl = streamText
): ModelClient {
  return {
    async *streamStep({ system, messages, tools, signal }) {
      const result = streamTextImpl({
        model: getModel(modelKey),
        system,
        messages: messages.map(toAiSdkMessage),
        tools: toAiSdkTools(tools),
        maxSteps: 1,
        abortSignal: signal,
      } as any);

      for await (const part of result.fullStream as AsyncIterable<any>) {
        switch (part.type) {
          case "text-delta":
            yield { type: "text", text: part.textDelta ?? "" } satisfies ModelDelta;
            break;
          case "reasoning":
            yield { type: "reasoning", text: part.textDelta ?? "" } satisfies ModelDelta;
            break;
          case "tool-call":
            yield {
              type: "tool-call",
              id: part.toolCallId ?? "",
              name: part.toolName ?? "",
              args: (part.args as Record<string, unknown>) ?? {},
            } satisfies ModelDelta;
            break;
          case "error":
            throw part.error instanceof Error ? part.error : new Error(String(part.error));
          default:
            break;
        }
      }

      try {
        const usage = await result.usage;
        if (usage) {
          yield {
            type: "usage",
            inputTokens: usage.promptTokens ?? 0,
            outputTokens: usage.completionTokens ?? 0,
          } satisfies ModelDelta;
        }
      } catch {
        // usage 不可用 → 不发不抛
      }
    },
  };
}
