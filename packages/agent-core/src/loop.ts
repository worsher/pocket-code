// runAgentLoop: core 包的主循环,替换 App/Server 两侧旧 loop 实现。
// 循环语义详见 .superpowers/sdd/task-5-brief.md 的"循环语义 1-8"。
import { buildToolRegistry } from "./tools/registry.js";
import type {
  AgentEventType,
  CoreMessage,
  LoopStopReason,
  ModelClient,
  RunAgentResult,
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
): Promise<RunAgentResult> {
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
  // 初值 max_steps:for 循环自然耗尽即步数用完(此时最后 step 必有 toolCalls,
  // 否则早已在 end_turn 处 break),各提前退出点各自覆写(spec C12-2)。
  let stopReason: LoopStopReason = "max_steps";
  let steps = 0;
  let errorMessage: string | undefined;

  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) {
      stopReason = "aborted";
      break;
    }
    steps++;

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
      // spec D1:错误不再向调用方抛出,收敛为返回值。已积累的部分文本以纯文本
      // assistant 入史(不带 toolCalls——本 step 浮出的 toolCalls 未执行,带上
      // 会破坏"每个 toolCall 必有配对 tool 消息"的不变量,C12-5)。
      if (stepText.length > 0) messages.push({ role: "assistant", content: stepText });
      if (signal?.aborted) {
        // streamStep 因 abort 抛出(AbortError):归 aborted,不发 error 事件
        stopReason = "aborted";
      } else {
        errorMessage = err instanceof Error ? err.message : String(err);
        onEvent({ type: "error", message: errorMessage });
        stopReason = "error";
      }
      break;
    }

    // 3. 步末:assistant 消息(stepText+toolCalls)入 messages
    const assistantMsg: CoreMessage =
      toolCalls.length > 0
        ? { role: "assistant", content: stepText, toolCalls }
        : { role: "assistant", content: stepText };
    messages.push(assistantMsg);

    if (toolCalls.length === 0) {
      stopReason = "end_turn"; // 无 tool calls → 自然收束
      break;
    }

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
      stopReason = "aborted";
      break;
    }
  }

  // 7. 结束前发一次汇总 usage(累加值;两者均 0 则不发)。不发 done。
  if (totalInputTokens !== 0 || totalOutputTokens !== 0) {
    onEvent({ type: "usage", inputTokens: totalInputTokens, outputTokens: totalOutputTokens });
  }

  return {
    messages,
    fullText,
    stopReason,
    steps,
    usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
    ...(errorMessage !== undefined ? { errorMessage } : {}),
  };
}
