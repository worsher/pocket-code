// ── 出站消息 schema(server → App) ───────────────────────────
// P6b:固化 messageHandler/syncHandler 现有出站响应的契约。字段以现
// 运行时实际输出为准,不改协议语义;工具结果展开处用 passthrough。
// 消费者:server 构造处 satisfies 类型约束 + App 的 import type。

import { z } from "zod";
import { AgentEvent } from "./agentEvent.js";
import { WorkspaceProjectCatalogEntry, WorkspaceSessionScope } from "./workspace.js";

export const AuthMsg = z.object({
  type: z.literal("auth"),
  token: z.string(),
  userId: z.string(),
});

export const SessionMsg = z.object({
  type: z.literal("session"),
  /** Present only when both sides negotiate Workspace Storage v2. */
  workspaceProtocolVersion: z.literal(2).optional(),
  workspaceScope: WorkspaceSessionScope.optional(),
  workspaceCatalog: z.array(WorkspaceProjectCatalogEntry).optional(),
  sessionId: z.string(),
  projectId: z.string(),
  workspace: z.string(),
  // P14:事件流游标(缓冲世代 + 当前最高 seq),客户端据此协商补发
  eventEpoch: z.string().optional(),
  currentSeq: z.number().int().nonnegative().optional(),
});

/** P14:server 无法用缓冲覆盖客户端缺口时的全量重建指示(spec C14-4)。 */
export const ResyncRequiredMsg = z.object({
  type: z.literal("resync-required"),
  reason: z.enum(["epoch-changed", "buffer-overflow", "unknown-session"]),
  eventEpoch: z.string(),
  currentSeq: z.number().int().nonnegative(),
});

export const QuotaMsg = z.object({
  type: z.literal("quota"),
  userId: z.string(),
  tier: z.string(),
  limits: z.record(z.unknown()),
  usage: z.record(z.unknown()),
});

export const FileListMsg = z
  .object({
    type: z.literal("file-list"),
    path: z.string(),
    _reqId: z.string().optional(),
    success: z.boolean().optional(),
    items: z.array(z.unknown()).optional(),
    error: z.string().optional(),
  })
  .passthrough();

export const FileContentMsg = z
  .object({
    type: z.literal("file-content"),
    path: z.string(),
    _reqId: z.string().optional(),
    success: z.boolean().optional(),
    content: z.string().optional(),
    error: z.string().optional(),
  })
  .passthrough();

export const SyncManifestMsg = z.object({
  type: z.literal("sync-manifest"),
  commit: z.string(),
  parent: z.string().nullable().optional(),
  files: z.array(z.object({ path: z.string(), status: z.enum(["A", "M", "D"]) })),
  _reqId: z.string().optional(),
});

export const SyncFileContentMsg = z.object({
  type: z.literal("sync-file-content"),
  path: z.string(),
  encoding: z.literal("base64").optional(),
  content: z.string().optional(),
  error: z.string().optional(),
  _reqId: z.string().optional(),
});

export const SessionsListMsg = z.object({
  type: z.literal("sessions-list"),
  sessions: z.array(z.record(z.unknown())),
});

export const SessionDeletedMsg = z.object({
  type: z.literal("session-deleted"),
  sessionId: z.string(),
  success: z.boolean(),
});

export const ProjectWorkspaceDeletedMsg = z.object({
  type: z.literal("project-workspace-deleted"),
  projectId: z.string(),
  success: z.boolean(),
  error: z.string().optional(),
});

export const ServerErrorMsg = z.object({
  type: z.literal("error"),
  error: z.string(),
});

/** server → App 的一切出站消息(流式 AgentEvent ∪ 控制响应) */
export const ServerOutbound = z.union([
  AgentEvent,
  AuthMsg,
  SessionMsg,
  QuotaMsg,
  FileListMsg,
  FileContentMsg,
  SyncManifestMsg,
  SyncFileContentMsg,
  SessionsListMsg,
  SessionDeletedMsg,
  ProjectWorkspaceDeletedMsg,
  ServerErrorMsg,
  ResyncRequiredMsg,
]);
export type ServerOutboundType = z.infer<typeof ServerOutbound>;
