// ── Normalized Agent Event Protocol ───────────────────────
// App 唯一消费的事件契约，不关心由谁产生：DelegatedCliAgent(包装
// claude-code/codex/gemini) 或 in-app BuiltinAgent loop。各 adapter
// 把原生输出归一化到此判别联合。详见 spec 第 3.2 节。

import { z } from "zod";

export const TextDeltaEvent = z.object({
  type: z.literal("text-delta"),
  text: z.string(),
});

export const ReasoningDeltaEvent = z.object({
  type: z.literal("reasoning-delta"),
  text: z.string(),
});

export const ToolCallEvent = z.object({
  type: z.literal("tool-call"),
  callId: z.string(),
  name: z.string(),
  args: z.record(z.unknown()),
});

export const ToolResultEvent = z.object({
  type: z.literal("tool-result"),
  callId: z.string(),
  result: z.unknown(),
  isError: z.boolean().optional(),
});

export const FileChangedEvent = z.object({
  type: z.literal("file-changed"),
  path: z.string(),
  changeType: z.enum(["created", "modified", "deleted"]),
  oldContent: z.string().optional(),
  newContent: z.string().optional(),
});

export const CommandOutputEvent = z.object({
  type: z.literal("command-output"),
  callId: z.string(),
  chunk: z.string(),
  stream: z.enum(["stdout", "stderr"]),
});

export const ProcessStartedEvent = z.object({
  type: z.literal("process-started"),
  processId: z.string(),
  command: z.string(),
  cwd: z.string().optional(),
});

export const ProcessExitedEvent = z.object({
  type: z.literal("process-exited"),
  processId: z.string(),
  exitCode: z.number().int(),
});

export const PreviewAvailableEvent = z.object({
  type: z.literal("preview-available"),
  url: z.string(),
  source: z.enum(["dev-server", "static"]),
});

export const ModelSelectedEvent = z.object({
  type: z.literal("model-selected"),
  modelKey: z.string(),
  reason: z.string().optional(),
});

/** step 级瞬时错误重试通告(每次重发前恰发一条,spec 2026-07-21 C13-6)。 */
export const StepRetryingEvent = z.object({
  type: z.literal("step-retrying"),
  failedAttempt: z.number().int().positive(),
  nextAttempt: z.number().int().positive(),
  maxAttempts: z.number().int().positive(),
  delayMs: z.number().int().nonnegative(),
  statusCode: z.number().int().optional(),
  message: z.string().optional(),
});

/** 媒体降级通告:发送投影降级(degraded 保留最近一张 / stripped 全剥离,spec §4.3)。 */
export const MediaDegradedEvent = z.object({
  type: z.literal("media-degraded"),
  level: z.enum(["degraded", "stripped"]),
  keptImages: z.number().int().nonnegative(),
});

export const UsageEvent = z.object({
  type: z.literal("usage"),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});

export const DoneEvent = z.object({
  type: z.literal("done"),
  /** turn 结束原因(BuiltinAgent 路径必带;CLI 委托路径缺省,按 end_turn 解释)。spec C12-4。 */
  stopReason: z.enum(["end_turn", "max_steps", "aborted", "error"]).optional(),
  /** 本 turn 累计 usage(冗余汇总,独立 usage 事件仍保留)。 */
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
    })
    .optional(),
});

export const ErrorEvent = z.object({
  type: z.literal("error"),
  message: z.string(),
  code: z.string().optional(),
});

/** 判别联合：App 渲染层只消费此契约 */
export const AgentEvent = z.discriminatedUnion("type", [
  TextDeltaEvent,
  ReasoningDeltaEvent,
  ToolCallEvent,
  ToolResultEvent,
  FileChangedEvent,
  CommandOutputEvent,
  ProcessStartedEvent,
  ProcessExitedEvent,
  PreviewAvailableEvent,
  ModelSelectedEvent,
  StepRetryingEvent,
  MediaDegradedEvent,
  UsageEvent,
  DoneEvent,
  ErrorEvent,
]);

export type AgentEventType = z.infer<typeof AgentEvent>;

/** 联合内全部事件 type 名(单一真相源;client-core 分发层据此路由,勿手写复制)。 */
export const AGENT_EVENT_TYPE_NAMES: readonly string[] = AgentEvent.options.map(
  (o) => o.shape.type.value,
);
