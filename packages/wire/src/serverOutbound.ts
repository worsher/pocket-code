// ── 出站消息 schema(server → App) ───────────────────────────
// P6b:固化 messageHandler/syncHandler 现有出站响应的契约。字段以现
// 运行时实际输出为准,不改协议语义;工具结果展开处用 passthrough。
// 消费者:server 构造处 satisfies 类型约束 + App 的 import type。

import { z } from "zod";
import { AgentEvent } from "./agentEvent.js";
import {
  WorkspaceImportSource,
  WorkspaceProjectCatalogEntry,
  WorkspaceSessionScope,
} from "./workspace.js";
import { GitWorkspaceOperation } from "./messages.js";

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
  /** Canonical cross-platform content snapshot (not a Git commit ID). */
  snapshot: z.string().length(64),
  parent: z.string().nullable().optional(),
  full: z.boolean(),
  files: z.array(
    z.object({
      path: z.string(),
      status: z.enum(["A", "M", "D"]),
      size: z.number().int().nonnegative().optional(),
      digest: z.string().length(32).optional(),
    })
  ),
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

export const WorkspaceWriterReleasedMsg = z.object({
  type: z.literal("workspace-writer-released"),
  projectId: z.string().uuid(),
  replicaId: z.string().uuid(),
  success: z.boolean(),
  workspaceGeneration: z.number().int().positive().optional(),
  error: z.string().optional(),
  _reqId: z.string(),
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

export const WorkspaceImportResultMsg = z.object({
  type: z.literal("workspace-import-result"),
  _reqId: z.string(),
  status: z.enum(["imported", "confirmation-required", "blocked", "error"]),
  existingProjectId: z.string().uuid().optional(),
  project: WorkspaceProjectCatalogEntry.optional(),
  importSource: WorkspaceImportSource.optional(),
  error: z.string().optional(),
});

export const WorkspaceSourceStatusMsg = z.object({
  type: z.literal("workspace-source-status"),
  _reqId: z.string(),
  projectId: z.string().uuid(),
  state: z.enum(["available", "permission-lost", "moved", "missing", "replaced", "unsupported"]),
  checkedAt: z.number().int().nonnegative(),
  canonicalLocator: z.string().optional(),
  resolvedLocator: z.string().optional(),
  stableFileId: z.string().optional(),
  error: z.string().optional(),
});

export const WorkspaceLegacyCleanedMsg = z.object({
  type: z.literal("workspace-legacy-cleaned"),
  _reqId: z.string(),
  projectId: z.string().uuid(),
  legacyProjectId: z.string(),
  success: z.boolean(),
  cleaned: z.boolean(),
  error: z.string().optional(),
});

export const GitRpcErrorCode = z.enum([
  "auth_required",
  "credential_not_found",
  "permission_denied",
  "token_expired",
  "host_mismatch",
  "tls_error",
  "repo_not_found",
  "network_error",
  "dirty_worktree",
  "conflict",
  "non_fast_forward",
  "unsupported",
  "invalid_request",
  "encryption_required",
  "encryption_key_mismatch",
  "decryption_failed",
  "internal_error",
]);

export const GitRpcError = z.object({
  code: GitRpcErrorCode,
  message: z.string().min(1).max(4096),
  retryable: z.boolean().optional(),
});

export const GitCredentialResultMsg = z.object({
  type: z.literal("git-credential-result"),
  _reqId: z.string().min(1).max(128),
  credentialProfileId: z.string().min(1).max(128),
  operation: z.enum(["upsert", "test", "delete"]),
  success: z.boolean(),
  capabilities: z
    .object({
      read: z.boolean(),
      write: z.boolean(),
    })
    .optional(),
  error: GitRpcError.optional(),
});

export const GitOperationResultMsg = z.object({
  type: z.literal("git-operation-result"),
  _reqId: z.string().min(1).max(128),
  projectId: z.string().uuid(),
  operation: GitWorkspaceOperation,
  success: z.boolean(),
  head: z.string().min(1).max(128).optional(),
  summary: z.string().max(4096).optional(),
  error: GitRpcError.optional(),
});

export const ServerErrorMsg = z.object({
  type: z.literal("error"),
  error: z.string(),
  _reqId: z.string().optional(),
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
  WorkspaceWriterReleasedMsg,
  SessionsListMsg,
  SessionDeletedMsg,
  ProjectWorkspaceDeletedMsg,
  WorkspaceImportResultMsg,
  WorkspaceSourceStatusMsg,
  WorkspaceLegacyCleanedMsg,
  GitCredentialResultMsg,
  GitOperationResultMsg,
  ServerErrorMsg,
  ResyncRequiredMsg,
]);
export type ServerOutboundType = z.infer<typeof ServerOutbound>;
export type GitRpcErrorCodeType = z.infer<typeof GitRpcErrorCode>;
export type GitRpcErrorType = z.infer<typeof GitRpcError>;
export type GitCredentialResultMsgType = z.infer<typeof GitCredentialResultMsg>;
export type GitOperationResultMsgType = z.infer<typeof GitOperationResultMsg>;
