// ── Shared WebSocket Message Schemas ──────────────────────
// Defines all message types used across App, Relay, and Daemon.
// Extends the original pocket-code wsSchemas with relay envelope types.

import { z } from "zod";

// ── Helpers ────────────────────────────────────────────

/** Accept string, undefined, or null — coerce null to undefined */
const optStr = (maxLen = 1024) =>
  z
    .string()
    .max(maxLen)
    .optional()
    .nullable()
    .transform((v) => v ?? undefined);

// ── Original pocket-code message schemas ───────────────

export const RegisterMessage = z.object({
  type: z.literal("register"),
  deviceId: z.string().min(1).max(128),
});

export const InitMessage = z.object({
  type: z.literal("init"),
  /** Opt-in marker. Missing means a v1 client and remains fully supported. */
  workspaceProtocolVersion: z.literal(2).optional(),
  token: optStr(),
  sessionId: optStr(128),
  projectId: optStr(128),
  projectName: optStr(256),
  model: optStr(64),
  customPrompt: optStr(10000),
  // P14:重连补发协商——客户端已应用的最后事件 seq 与其所属 epoch(spec §5.2)
  lastSeq: z
    .number()
    .int()
    .min(0)
    .optional()
    .nullable()
    .transform((v) => v ?? undefined),
  eventEpoch: optStr(64),
  gitCredentials: z
    .array(
      z.object({
        platform: z.string(),
        host: z.string(),
        username: z.string(),
        token: z.string(),
      })
    )
    .optional()
    .nullable()
    .transform((v) => v ?? undefined),
});

export const MessageMessage = z.object({
  type: z.literal("message"),
  content: z.string().min(1).max(100000),
  model: optStr(64),
  customPrompt: optStr(10000),
  rewindTo: z
    .number()
    .int()
    .min(0)
    .optional()
    .nullable()
    .transform((v) => v ?? undefined),
  images: z
    .array(
      z.object({
        base64: z.string(),
        mimeType: z.string(),
      })
    )
    .max(10)
    .optional()
    .nullable()
    .transform((v) => v ?? undefined),
});

export const ToolExecMessage = z.object({
  type: z.literal("tool-exec"),
  toolName: z.string().min(1).max(64),
  args: z.record(z.unknown()),
  callId: optStr(),
});

export const ListFilesMessage = z.object({
  type: z.literal("list-files"),
  path: optStr(1024),
  _reqId: optStr(),
});

export const ReadFileMessage = z.object({
  type: z.literal("read-file"),
  path: z.string().min(1).max(1024),
  _reqId: optStr(),
});

export const ListSessionsMessage = z.object({
  type: z.literal("list-sessions"),
  projectId: optStr(128),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .nullable()
    .transform((v) => v ?? undefined),
});

export const DeleteSessionMessage = z.object({
  type: z.literal("delete-session"),
  sessionId: z.string().min(1).max(128),
});

export const DeleteProjectWorkspaceMessage = z.object({
  type: z.literal("delete-project-workspace"),
  projectId: z.string().min(1).max(128),
});

export const GetQuotaMessage = z.object({
  type: z.literal("get-quota"),
});

export const AbortMessage = z.object({
  type: z.literal("abort"),
});

// ── P16:Goal 模式(spec §7)─────────────────────────────
export const GoalCreateMessage = z.object({
  type: z.literal("goal-create"),
  content: z.string().min(1).max(20000),
  acceptance: optStr(10000),
  replace: z
    .boolean()
    .optional()
    .nullable()
    .transform((v) => v ?? undefined),
  maxTurns: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .nullable()
    .transform((v) => v ?? undefined),
});

export const GoalControlMessage = z.object({
  type: z.literal("goal-control"),
  action: z.enum(["pause", "resume", "cancel"]),
});

export const SyncPullMessage = z.object({
  type: z.literal("sync-pull"),
  sinceCommit: optStr(64),
  _reqId: optStr(),
});

export const SyncFileMessage = z.object({
  type: z.literal("sync-file"),
  commit: z.string().min(1).max(64),
  path: z.string().min(1).max(2048),
  _reqId: optStr(),
});

export const BindLinkedWorkspaceMessage = z.object({
  type: z.literal("workspace-bind-linked"),
  projectId: z.string().uuid(),
  displayName: optStr(256),
  path: z.string().min(1).max(4096),
  allowWeakDuplicate: z.boolean().optional(),
  _reqId: z.string().min(1).max(128),
});

/** Discriminated union of all valid business messages */
export const WsMessage = z.discriminatedUnion("type", [
  RegisterMessage,
  InitMessage,
  MessageMessage,
  ToolExecMessage,
  ListFilesMessage,
  ReadFileMessage,
  ListSessionsMessage,
  DeleteSessionMessage,
  DeleteProjectWorkspaceMessage,
  GetQuotaMessage,
  AbortMessage,
  GoalCreateMessage,
  GoalControlMessage,
  SyncPullMessage,
  SyncFileMessage,
  BindLinkedWorkspaceMessage,
]);

export type WsMessageType = z.infer<typeof WsMessage>;
