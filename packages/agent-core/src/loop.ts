// runAgentLoop: core 包的主循环,替换 App/Server 两侧旧 loop 实现。
// 循环语义详见 .superpowers/sdd/task-5-brief.md 的"循环语义 1-8"。
import { buildToolRegistry } from "./tools/registry.js";
import type {
  AgentEventType,
  CoreMessage,
  ModelClient,
  RuntimeBackend,
  ToolCallReq,
} from "./types.js";

export interface RunAgentOptions {
  modelClient: ModelClient;
  backend: RuntimeBackend;
  workspace: string; // 供 registry 的 safePath
  system: string;
  history: CoreMessage[]; // 不含本轮 user
  userMessage: string;
  images?: { base64: string; mimeType: string }[];
  onEvent: (ev: AgentEventType) => void;
  signal?: AbortSignal;
  maxSteps?: number; // 默认 25
}

const FILE_CHANGE_TOOLS = new Set(["writeFile", "editFile"]);

export async function runAgentLoop(
  opts: RunAgentOptions,
): Promise<{ messages: CoreMessage[]; fullText: string }> {
  const { modelClient, backend, workspace, system, history, userMessage, images, onEvent, signal } = opts;
  const maxSteps = opts.maxSteps ?? 25;

  const registry = buildToolRegistry(backend, workspace);

  // 1. user 消息入 messages(有 images → ContentPart[]:text + images)
  const userContent =
    images && images.length > 0
      ? [{ type: "text" as const, text: userMessage }, ...images.map((img) => ({ type: "image" as const, ...img }))]
      : userMessage;
  const messages: CoreMessage[] = [...history, { role: "user", content: userContent }];

  let fullText = "";
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) break;

    let stepText = "";
    const toolCalls: ToolCallReq[] = [];

    try {
      for await (const delta of modelClient.streamStep({ system, messages: [...messages], tools: registry.schemas, signal })) {
        switch (delta.type) {
          case "text":
            stepText += delta.text;
            fullText += delta.text;
            onEvent({ type: "text-delta", text: delta.text });
            break;
          case "reasoning":
            onEvent({ type: "reasoning-delta", text: delta.text });
            break;
          case "tool-call":
            toolCalls.push({ id: delta.id, name: delta.name, args: delta.args });
            break;
          case "usage":
            totalInputTokens += delta.inputTokens || 0;
            totalOutputTokens += delta.outputTokens || 0;
            break;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onEvent({ type: "error", message });
      throw err;
    }

    // 3. 步末:assistant 消息(stepText+toolCalls)入 messages
    const assistantMsg: CoreMessage =
      toolCalls.length > 0
        ? { role: "assistant", content: stepText, toolCalls }
        : { role: "assistant", content: stepText };
    messages.push(assistantMsg);

    if (toolCalls.length === 0) break; // 无 tool calls → 结束

    const executedCallIds = new Set<string>();

    for (const call of toolCalls) {
      if (signal?.aborted) break;

      onEvent({ type: "tool-call", callId: call.id, name: call.name, args: call.args });
      const result = await registry.run(call.name, call.args);

      if (FILE_CHANGE_TOOLS.has(call.name)) {
        const r = result as { success?: boolean; path?: string; isNew?: boolean } | undefined;
        if (r && r.success && r.path) {
          onEvent({
            type: "file-changed",
            path: r.path,
            changeType: r.isNew ? "created" : "modified",
          });
        }
      }

      const isError = (result as { success?: boolean } | undefined)?.success === false;
      onEvent({ type: "tool-result", callId: call.id, result, isError });

      messages.push({
        role: "tool",
        toolCallId: call.id,
        toolName: call.name,
        content: JSON.stringify(result),
      });
      executedCallIds.add(call.id);
    }

    // I-1: abort 可能在工具循环中途 break,导致上面 assistant 消息里还有未配对的 toolCalls
    // (下游 Chat API 要求每个 toolCall 都有对应 tool 消息,否则 400)。为每个未执行的 toolCall
    // 补一条合成失败结果,只维护消息不变量,不发任何事件。
    if (signal?.aborted) {
      for (const call of toolCalls) {
        if (executedCallIds.has(call.id)) continue;
        messages.push({
          role: "tool",
          toolCallId: call.id,
          toolName: call.name,
          content: JSON.stringify({ success: false, error: "aborted" }),
        });
      }
      break;
    }
  }

  // 7. 结束前发一次汇总 usage(累加值;两者均 0 则不发)。不发 done。
  if (totalInputTokens !== 0 || totalOutputTokens !== 0) {
    onEvent({ type: "usage", inputTokens: totalInputTokens, outputTokens: totalOutputTokens });
  }

  return { messages, fullText };
}
