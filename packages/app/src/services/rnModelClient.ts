// ── RnModelClient ──────────────────────────────────────
// P9 Task 9/10: 把 App 现有 aiClient 的 callbacks 风格 SSE 流适配成
// agent-core ModelClient 的 AsyncIterable 风格,供 App 侧 geek 模式的
// 同构 agent 循环(runAgentLoop)使用。
//
// T10:req.system/req.tools 接线完成——system 直传 aiClient.streamChat 的
// systemPrompt 参数,tools 经 toToolDefinitions 转换后传入(见下方 streamStep
// 内部实现)。cfg 不再保留 customPrompt——system 全量来自 req.system 单一来源
// (useAgent 层用 buildSystemPrompt({customPrompt}) 拼好后经 req.system 传入,
// 语义等价)。

import type { CoreMessage, ModelClient, ModelDelta, ToolSchema } from "@pocket-code/agent-core";
import { streamChat, type ChatMessage, type ContentPart as AiContentPart, type ToolCallRequest, type ToolDefinition } from "./aiClient";
import type { ModelConfig } from "./modelConfig";

// ── 队列桥接器:callbacks → AsyncIterable ───────────────

/**
 * 把"注册 onDelta/onDone/onError 回调,立即开始产生数据"的启动函数
 * 包装成 AsyncIterable<ModelDelta>。
 *
 * 实现:内部数组队列 + pending resolver。onDelta 入队并唤醒等待中的
 * next();onDone 标记终结(队列排空后返回 done);onError 让下一次
 * next() 抛出(通过 reject 一个 pending promise)。
 *
 * 终结语义(单向锁,Important #2):一旦 onDone/onError 触发或消费方
 * 调用 return() 提前退出,`terminated` 置真且不可逆——此后任何 onDelta
 * 都被静默丢弃,next() 恒返回 `{done:true}`(error 情形下,error 只在
 * "队列已排空"的那一次 next() 抛出一次,此后同样恒 done)。
 *
 * cleanup(Important #3):消费方 break/return() 提前退出时,通过可选的
 * onCleanup 回调通知调用方做资源回收(例如 abort 底层 XHR),避免流量/
 * delta 在无人消费的情况下继续堆积。
 */
export function callbacksToAsyncIterable(
  start: (cb: {
    onDelta: (d: ModelDelta) => void;
    onDone: () => void;
    onError: (msg: string) => void;
  }) => void,
  onCleanup?: () => void
): AsyncIterable<ModelDelta> {
  const queue: ModelDelta[] = [];
  let terminated = false; // 单向锁:一旦置真永不回退
  let error: string | undefined;
  let errorThrown = false;
  // 等待中的 next() 调用:队列为空且未终结时,next() 挂起在这里,
  // 由 onDelta/onDone/onError/return() 唤醒。
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
      // 终结锁一旦置位,后续 onDelta 全部丢弃(不复活迭代器)。
      if (terminated) return;
      queue.push(d);
      wake();
    },
    onDone: () => {
      terminated = true;
      wake();
    },
    onError: (msg) => {
      if (terminated) return;
      error = msg;
      terminated = true;
      wake();
    },
  });

  return {
    [Symbol.asyncIterator](): AsyncIterator<ModelDelta> {
      return {
        async next(): Promise<IteratorResult<ModelDelta>> {
          // 队列有数据就先吐出来,即便已经 terminated(不丢已产生的 delta)。
          while (queue.length === 0 && !terminated) {
            await new Promise<void>((resolve) => {
              pendingResolve = resolve;
            });
          }
          if (queue.length > 0) {
            const value = queue.shift()!;
            return { value, done: false };
          }
          if (error !== undefined && !errorThrown) {
            errorThrown = true;
            throw new Error(error);
          }
          return { value: undefined as any, done: true };
        },
        async return(): Promise<IteratorResult<ModelDelta>> {
          // consumer 提前 break:置终结锁、清空队列、级联通知调用方清理
          // (如 abort 底层 XHR),防止流继续跑、delta 无人消费地堆积。
          const wasTerminated = terminated;
          terminated = true;
          queue.length = 0;
          // M2(T9 复审 Minor):若此时还有一个尚未抛出的残留 error(consumer 提前
          // return() 而不是继续 next() 到抛出它的那一次),必须一并清除——否则
          // 理论上仍有路径能在 return() 之后再抛出这个 error,违反"return() 之后
          // next() 恒 done:true"的契约。errorThrown 置真即让下面 next() 的
          // `error !== undefined && !errorThrown` 判断恒假。
          error = undefined;
          errorThrown = true;
          wake();
          if (!wasTerminated) onCleanup?.();
          return { value: undefined as any, done: true };
        },
      };
    },
  };
}

// ── 消息转换:CoreMessage(agent-core) → ChatMessage(aiClient) ──
// 方向:CoreMessage[](agent-core 同构消息)→ ChatMessage[](aiClient 消息)。

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

// ── 工具转换:core ToolSchema → aiClient ToolDefinition ─
// core 的 ToolSchema 是 {name,description,parameters}(见 agent-core/src/types.ts);
// aiClient 的 ToolDefinition 是 OpenAI function-calling 形状
// {type:"function", function:{name,description,parameters}}(见 aiClient.ts)。
// streamChatAnthropic 内部会再从这个形状转成 Anthropic 的 {name,description,input_schema}。

export function toToolDefinitions(schemas: ToolSchema[]): ToolDefinition[] {
  return schemas.map((s) => ({
    type: "function" as const,
    function: {
      name: s.name,
      description: s.description,
      parameters: s.parameters,
    },
  }));
}

// ── ModelClient 工厂 ────────────────────────────────────

/** `streamChat` 的类型别名,便于测试注入替身实现(见 createRnModelClientForTest)。 */
type StreamChatFn = typeof streamChat;

function buildStreamStep(
  cfg: {
    modelConfig: ModelConfig;
    apiKey: string;
  },
  streamChatImpl: StreamChatFn
): ModelClient["streamStep"] {
  const { modelConfig, apiKey } = cfg;

  return function streamStep(req: {
    system: string;
    messages: CoreMessage[];
    tools: ToolSchema[];
    signal?: AbortSignal;
  }): AsyncIterable<ModelDelta> {
    const messages = toChatMessages(req.messages);
    const tools = toToolDefinitions(req.tools);

    // Critical #1: aiClient.streamChat 在 signal abort 时只
    // xhr.abort()+resolve()——不调用 onDone/onError 任何回调
    // (见 aiClient.ts streamChatOpenAI/Anthropic 的 abort 监听:
    // `signal.addEventListener("abort", () => { xhr.abort(); finish(); })`,
    // finish() 只 resolve,从不 reject/不回调 callbacks)。
    // 若桥接器只依赖 aiClient 的回调来终结,abort 时 for-await 会永久挂起。
    // 修复:在这里对 req.signal 独立注册一个 abort 监听,一旦触发就
    // 直接调桥接的 onError("aborted")——与 agent-core loop 的 abort 语义
    // 对齐(loop.ts 捕获 for-await 抛出的错误后 emit error 事件、rethrow,
    // 再由外层 tool 循环走"孤儿 tool 结果补齐"路径,见 loop.ts:118-132)。
    //
    // Important #3: 消费方(loop 的 for-await)提前 break 时,底层 aiClient
    // 请求应当被级联取消,而不是继续跑、把 delta 堆积在无人消费的队列里。
    // 为此建一个内部 AbortController,把 req.signal 链上(req.signal abort
    // → 内部 controller abort),真正传给 streamChat 的是内部 signal;
    // callbacksToAsyncIterable 的 onCleanup 回调里 abort 这个内部 controller,
    // 这样不管是"外部 signal abort"还是"consumer return()/break",都能统一
    // 触达同一个内部 controller,取消底层请求。
    const internalController = new AbortController();
    if (req.signal) {
      if (req.signal.aborted) {
        internalController.abort();
      } else {
        req.signal.addEventListener("abort", () => internalController.abort());
      }
    }

    return callbacksToAsyncIterable(
      ({ onDelta, onDone, onError }) => {
        // req.system 直传 aiClient.streamChat 的必传 systemPrompt 参数;req.tools
        // (core ToolSchema[])经 toToolDefinitions 转换为 aiClient ToolDefinition[]
        // 再传入(T10 接线;system/tools 单一来源均来自 runAgentLoop 调用方,cfg 不再
        // 保留 customPrompt——见 createRnModelClient 签名变化)。

        let settled = false; // 防止 aiClient 正常完成路径与 abort 路径重复终结
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          fn();
        };

        // M1(T9 复审 Minor):无论走哪条终结路径,都要 removeEventListener,
        // 避免监听器泄漏在已终结的 internalController.signal 上。用一个
        // 共享的 cleanup 包一层,四条终结路径(onAbort 自身/onDone/onError/
        // catch)统一调用。
        const cleanupAbortListener = () =>
          internalController.signal.removeEventListener("abort", onAbort);

        // 独立的 abort 终结通道:与 aiClient 内部的 onDone/onError 完全解耦,
        // 保证即便 aiClient 在 abort 时"什么都不调用",桥接器也能终结。
        function onAbort() {
          finish(() => {
            cleanupAbortListener();
            onError("aborted");
          });
        }
        if (internalController.signal.aborted) {
          // 注册前检查 signal 可能已经 aborted(例如上游在 streamStep 调用
          // 之前就已经 abort 了)。未注册监听器,故无需 cleanup。
          finish(() => onError("aborted"));
          return;
        }
        internalController.signal.addEventListener("abort", onAbort);

        void streamChatImpl({
          model: modelConfig,
          apiKey,
          messages,
          signal: internalController.signal,
          systemPrompt: req.system,
          tools,
          callbacks: {
            onTextDelta: (text) => onDelta({ type: "text", text }),
            onThinking: (text) => onDelta({ type: "reasoning", text }),
            onToolCall: (id, name, args) => onDelta({ type: "tool-call", id, name, args }),
            onDone: () => finish(() => { cleanupAbortListener(); onDone(); }),
            onError: (msg) => finish(() => { cleanupAbortListener(); onError(msg); }),
          },
        }).catch((err) => finish(() => {
          cleanupAbortListener();
          onError(err instanceof Error ? err.message : String(err));
        }));
      },
      // Important #3 cleanup:consumer 提前 return()/break 时级联 abort 底层请求。
      () => internalController.abort()
    );
  };
}

export function createRnModelClient(cfg: {
  modelConfig: ModelConfig;
  apiKey: string;
}): ModelClient {
  return { streamStep: buildStreamStep(cfg, streamChat) };
}

/**
 * 仅供测试使用:允许注入替身 streamChat 实现,以便在不依赖真实 XHR/网络的
 * 情况下模拟 aiClient 的 abort 行为(例如"abort 时只 resolve,不调用任何
 * callback"这一真实存在的 bug 行为),验证 rnModelClient 桥接器自身的终结
 * 语义是否健壮。不用于生产代码路径。
 */
export function createRnModelClientForTest(
  cfg: {
    modelConfig?: ModelConfig;
    apiKey?: string;
    streamChatImpl: StreamChatFn;
  }
): ModelClient {
  const { streamChatImpl, ...rest } = cfg;
  return {
    streamStep: buildStreamStep(
      {
        modelConfig: rest.modelConfig ?? ({} as ModelConfig),
        apiKey: rest.apiKey ?? "test-key",
      },
      streamChatImpl
    ),
  };
}
