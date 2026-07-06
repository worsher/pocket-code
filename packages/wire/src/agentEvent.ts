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

export const UsageEvent = z.object({
  type: z.literal("usage"),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});

export const DoneEvent = z.object({
  type: z.literal("done"),
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
  UsageEvent,
  DoneEvent,
  ErrorEvent,
]);

export type AgentEventType = z.infer<typeof AgentEvent>;
