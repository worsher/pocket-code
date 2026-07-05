// ── 出站消息 schema(server → App) ───────────────────────────
// P6b:固化 messageHandler/syncHandler 现有出站响应的契约。字段以现
// 运行时实际输出为准,不改协议语义;工具结果展开处用 passthrough。
// 消费者:server 构造处 satisfies 类型约束 + App 的 import type。

import { z } from "zod";
import { AgentEvent } from "./agentEvent.js";

export const AuthMsg = z.object({
  type: z.literal("auth"),
  token: z.string(),
  userId: z.string(),
});

export const SessionMsg = z.object({
  type: z.literal("session"),
  sessionId: z.string(),
  projectId: z.string(),
  workspace: z.string(),
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
  files: z.array(z.object({ path: z.string(), status: z.string() }).passthrough()),
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
]);
export type ServerOutboundType = z.infer<typeof ServerOutbound>;
