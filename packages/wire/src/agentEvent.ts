// ── Normalized Agent Event Protocol ───────────────────────
// App 唯一消费的事件契约，不关心由谁产生：DelegatedCliAgent(包装
// claude-code/codex/gemini) 或 in-app BuiltinAgent loop。各 adapter
// 把原生输出归一化到此判别联合。详见 spec 第 3.2 节。

import { z } from "zod";
import { WorkspaceSessionScope } from "./workspace.js";

// 共用事件元数据。字段均可选，以保持 geek in-process 路径与混合版本兼容。
// turnId 由发起 turn 的客户端生成（旧客户端缺省时 server 可代生成）；seq 由
// server 侧 eventBuffer 按 session 分配，客户端按 (epoch, seq) 去重。
const eventMetaFields = {
  turnId: z.string().min(1).max(128).optional(),
  seq: z.number().int().positive().optional(),
};

export const TextDeltaEvent = z.object({
  type: z.literal("text-delta"),
  text: z.string(),
  ...eventMetaFields,
});

export const ReasoningDeltaEvent = z.object({
  type: z.literal("reasoning-delta"),
  text: z.string(),
  ...eventMetaFields,
});

export const ToolCallEvent = z.object({
  type: z.literal("tool-call"),
  callId: z.string(),
  name: z.string(),
  args: z.record(z.unknown()),
  ...eventMetaFields,
});

export const ToolResultEvent = z.object({
  type: z.literal("tool-result"),
  callId: z.string(),
  result: z.unknown(),
  isError: z.boolean().optional(),
  ...eventMetaFields,
});

export const FileChangedEvent = z.object({
  type: z.literal("file-changed"),
  path: z.string(),
  changeType: z.enum(["created", "modified", "deleted"]),
  oldContent: z.string().optional(),
  newContent: z.string().optional(),
  /** Optional for mixed-version compatibility; v2 servers attach it. */
  workspaceScope: WorkspaceSessionScope.optional(),
  ...eventMetaFields,
});

export const CommandOutputEvent = z.object({
  type: z.literal("command-output"),
  callId: z.string(),
  chunk: z.string(),
  stream: z.enum(["stdout", "stderr"]),
  ...eventMetaFields,
});

export const ProcessStartedEvent = z.object({
  type: z.literal("process-started"),
  processId: z.string(),
  command: z.string(),
  cwd: z.string().optional(),
  ...eventMetaFields,
});

export const ProcessExitedEvent = z.object({
  type: z.literal("process-exited"),
  processId: z.string(),
  exitCode: z.number().int(),
  ...eventMetaFields,
});

export const PreviewAvailableEvent = z.object({
  type: z.literal("preview-available"),
  url: z.string(),
  source: z.enum(["dev-server", "static"]),
  ...eventMetaFields,
});

export const ModelSelectedEvent = z.object({
  type: z.literal("model-selected"),
  modelKey: z.string(),
  reason: z.string().optional(),
  ...eventMetaFields,
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
  ...eventMetaFields,
});

/** 媒体降级通告:发送投影降级(degraded 保留最近一张 / stripped 全剥离,spec §4.3)。 */
export const MediaDegradedEvent = z.object({
  type: z.literal("media-degraded"),
  level: z.enum(["degraded", "stripped"]),
  keptImages: z.number().int().nonnegative(),
  ...eventMetaFields,
});

/** P15:turn 边界上下文压缩通告(token 数为估算值,spec §6)。 */
export const HistoryCompactedEvent = z.object({
  type: z.literal("history-compacted"),
  tokensBefore: z.number().int().nonnegative(),
  tokensAfter: z.number().int().nonnegative(),
  compactedMessages: z.number().int().nonnegative(),
  keptRecentTurns: z.number().int().nonnegative(),
  ...eventMetaFields,
});

/** P16:goal 状态变更通告。completion/cleared 为终局(此后 goal 已清除)。 */
export const GoalUpdatedEvent = z.object({
  type: z.literal("goal-updated"),
  status: z.enum(["active", "paused", "blocked", "complete"]),
  change: z.enum(["lifecycle", "completion", "cleared"]),
  stopReason: z.string().optional(),
  /** 卡片展示用(cleared 时缺省)。 */
  goal: z.string().optional(),
  stats: z.object({
    turns: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }),
  maxTurns: z.number().int().positive().optional(),
  ...eventMetaFields,
});

export const UsageEvent = z.object({
  type: z.literal("usage"),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  ...eventMetaFields,
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
  ...eventMetaFields,
});

export const ErrorEvent = z.object({
  type: z.literal("error"),
  message: z.string(),
  code: z.string().optional(),
  ...eventMetaFields,
});

/**
 * A durable completed turn is about to be replayed from its beginning. Clients
 * clear only that turn's partial assistant projection before applying the full
 * recorded event sequence, preventing duplicated deltas after a disconnect.
 */
export const TurnReplayResetEvent = z.object({
  type: z.literal("turn-replay-reset"),
  turnId: z.string().min(1).max(128),
  seq: z.number().int().positive().optional(),
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
  HistoryCompactedEvent,
  GoalUpdatedEvent,
  UsageEvent,
  DoneEvent,
  ErrorEvent,
  TurnReplayResetEvent,
]);

export type AgentEventType = z.infer<typeof AgentEvent>;

/** 联合内全部事件 type 名(单一真相源;client-core 分发层据此路由,勿手写复制)。 */
export const AGENT_EVENT_TYPE_NAMES: readonly string[] = AgentEvent.options.map(
  (o) => o.shape.type.value
);
