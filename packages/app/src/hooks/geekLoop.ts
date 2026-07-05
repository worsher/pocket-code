// ── geek 模式的纯函数辅助(从 useAgent 抽出,保持 hook 瘦身) ──
// P6b:App 侧 agent 循环 + 历史构建。UI 更新经 emitGeek 喂 chatReducer。
import { streamChat, type ChatMessage, type ToolCallRequest } from "../services/aiClient";
import type { ModelConfig } from "../services/modelConfig";
import type { AppSettings } from "../store/settings";
import type { StreamingPhase } from "../components/StreamingIndicator";
import type { Message } from "./chatReducer";
import type { AgentEventType } from "@pocket-code/wire";

/** geek 模式的 App 侧 agent 循环:多步 streamChat + 本地/远程工具执行,UI 更新经 emitGeek 喂 reducer。 */
export async function runGeekLoop(opts: {
  modelConfig: ModelConfig;
  apiKey: string;
  chatHistory: ChatMessage[];
  signal: AbortSignal;
  settings: AppSettings;
  customPrompt?: string;
  emitGeek: (ev: AgentEventType) => void;
  executeTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  setCurrentToolName: (name: string | undefined) => void;
  setStreamingPhase: (p: StreamingPhase) => void;
}): Promise<void> {
  const { modelConfig, apiKey, chatHistory, signal, settings, customPrompt, emitGeek, executeTool, setCurrentToolName, setStreamingPhase } = opts;
  const MAX_STEPS = 10;
  for (let step = 0; step < MAX_STEPS; step++) {
    let pendingToolCalls: { id: string; name: string; args: Record<string, unknown> }[] = [];
    let stepText = "";

    await streamChat({
      model: modelConfig, apiKey, messages: chatHistory, signal, settings, customPrompt,
      callbacks: {
        onTextDelta: (text) => { stepText += text; emitGeek({ type: "text-delta", text }); },
        onThinking: (text) => emitGeek({ type: "reasoning-delta", text }),
        onToolCall: (id, name, args) => {
          setCurrentToolName(name);
          pendingToolCalls.push({ id, name, args });
          emitGeek({ type: "tool-call", callId: id, name, args: args as Record<string, unknown> });
        },
        onDone: () => { },
        onError: (error) => emitGeek({ type: "error", message: String(error) }),
      },
    });

    if (pendingToolCalls.length === 0) break;

    const assistantToolCalls: ToolCallRequest[] = pendingToolCalls.map((tc) => ({
      id: tc.id, type: "function" as const,
      function: { name: tc.name, arguments: JSON.stringify(tc.args) },
    }));
    chatHistory.push({ role: "assistant", content: stepText, tool_calls: assistantToolCalls });

    for (const tc of pendingToolCalls) {
      try {
        setStreamingPhase("tool-running");
        setCurrentToolName(tc.name);
        const result = await executeTool(tc.name, tc.args);
        chatHistory.push({ role: "tool", content: JSON.stringify(result), tool_call_id: tc.id });
        emitGeek({ type: "tool-result", callId: tc.id, result });
      } catch (err: any) {
        const errorResult = { success: false, error: err.message };
        chatHistory.push({ role: "tool", content: JSON.stringify(errorResult), tool_call_id: tc.id });
        emitGeek({ type: "tool-result", callId: tc.id, result: errorResult });
      }
    }
  }
}

/** 消息列表 → aiClient chatHistory(OpenAI 格式;Anthropic 转换在 aiClient) */
export function buildChatHistory(msgs: Message[]): ChatMessage[] {
  const chatHistory: ChatMessage[] = [];
  for (const msg of msgs) {
    if (msg.role === "user") {
      if (msg.images?.length) {
        const contentParts: any[] = [{ type: "text", text: msg.content }];
        for (const img of msg.images) {
          contentParts.push({ type: "image_url", image_url: { url: `data:${img.mimeType};base64,${img.base64}` } });
        }
        chatHistory.push({ role: "user", content: contentParts } as any);
      } else {
        chatHistory.push({ role: "user", content: msg.content });
      }
    } else if (msg.role === "assistant") {
      if (msg.toolCalls?.length) {
        const toolCalls: ToolCallRequest[] = msg.toolCalls.map((tc, i) => ({
          id: `tc_hist_${msg.id}_${i}`,
          type: "function" as const,
          function: { name: tc.toolName, arguments: JSON.stringify(tc.args) },
        }));
        chatHistory.push({ role: "assistant", content: msg.content, tool_calls: toolCalls });
        msg.toolCalls.forEach((tc, i) => {
          if (tc.result !== undefined) {
            chatHistory.push({ role: "tool", content: JSON.stringify(tc.result), tool_call_id: `tc_hist_${msg.id}_${i}` });
          }
        });
      } else {
        chatHistory.push({ role: "assistant", content: msg.content });
      }
    }
  }
  return chatHistory;
}
