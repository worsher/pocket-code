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
  /** Legacy catalog key used only by the authenticated migration entrypoint. */
  legacyProjectId: optStr(128),
  projectName: optStr(256),
  /** Credential profile metadata only. Secrets use the explicit encrypted credential RPC. */
  gitCredentialProfileId: optStr(128),
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
  /**
   * @deprecated Legacy v1 transport. Kept only so rolling upgrades can still
   * parse old clients; current clients use the explicit credential RPCs below.
   */
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

export const ReleaseWorkspaceWriterMessage = z.object({
  type: z.literal("workspace-writer-release"),
  projectId: z.string().uuid(),
  replicaId: z.string().uuid(),
  workspaceGeneration: z.number().int().positive(),
  _reqId: z.string().min(1).max(128),
});

export const BindLinkedWorkspaceMessage = z.object({
  type: z.literal("workspace-bind-linked"),
  projectId: z.string().uuid(),
  displayName: optStr(256),
  path: z.string().min(1).max(4096),
  allowWeakDuplicate: z.boolean().optional(),
  _reqId: z.string().min(1).max(128),
});

export const InspectWorkspaceSourceMessage = z.object({
  type: z.literal("workspace-source-inspect"),
  projectId: z.string().uuid(),
  _reqId: z.string().min(1).max(128),
});

export const CleanupLegacyWorkspaceMessage = z.object({
  type: z.literal("workspace-legacy-cleanup"),
  projectId: z.string().uuid(),
  legacyProjectId: z.string().min(1).max(128),
  _reqId: z.string().min(1).max(128),
});

// ── Git credential / workspace RPCs ──────────────────

export const GitCredentialProvider = z.enum(["github", "gitee", "gitlab"]);
export const GitCredentialAuthKind = z.literal("pat");

/** Public metadata only. The secret is always transported separately. */
export const GitCredentialProfile = z.object({
  id: z.string().min(1).max(128),
  label: optStr(128),
  provider: GitCredentialProvider,
  authKind: GitCredentialAuthKind,
  origin: z.string().min(1).max(2048),
  username: optStr(256),
  pathPrefix: optStr(1024),
});

/**
 * Relay-safe encrypted secret envelope. URL/TLS policy and the requirement
 * that exactly one of secret/sealedSecret is supplied are enforced by the
 * receiving server/daemon, where connection mode is known.
 */
export const SealedSecretEnvelope = z.object({
  version: z.literal(1),
  algorithm: z.literal("x25519-xsalsa20-poly1305"),
  keyId: z.string().min(1).max(128),
  /** Authenticated binding metadata duplicated inside ciphertext. */
  profileId: z.string().min(1).max(128),
  origin: z.string().min(1).max(2048),
  issuedAt: z.number().int().nonnegative(),
  bindingNonce: z.string().min(1).max(128),
  requestId: z.string().min(1).max(128),
  ephemeralPublicKey: z.string().min(1).max(128),
  nonce: z.string().min(1).max(128),
  ciphertext: z.string().min(1).max(131072),
});

export const GitCredentialUpsertMessage = z.object({
  type: z.literal("git-credential-upsert"),
  profile: GitCredentialProfile,
  /** Direct WSS only. Relay clients must use sealedSecret. */
  secret: z.string().min(1).max(16384).optional(),
  sealedSecret: SealedSecretEnvelope.optional(),
  _reqId: z.string().min(1).max(128),
});

export const GitCredentialTestMessage = z.object({
  type: z.literal("git-credential-test"),
  credentialProfileId: z.string().min(1).max(128),
  repositoryUrl: z.string().min(1).max(4096),
  capability: z.enum(["read", "write"]).optional(),
  _reqId: z.string().min(1).max(128),
});

export const GitCredentialDeleteMessage = z.object({
  type: z.literal("git-credential-delete"),
  credentialProfileId: z.string().min(1).max(128),
  _reqId: z.string().min(1).max(128),
});

export const WorkspaceImportGitMessage = z.object({
  type: z.literal("workspace-import-git"),
  projectId: z.string().uuid(),
  displayName: optStr(256),
  repositoryUrl: z.string().min(1).max(4096),
  credentialProfileId: z.string().min(1).max(128),
  branch: optStr(255),
  _reqId: z.string().min(1).max(128),
});

export const GitWorkspaceOperation = z.enum(["status", "pull", "commit", "push"]);

export const GitWorkspaceOperationMessage = z.object({
  type: z.literal("git-workspace-operation"),
  projectId: z.string().uuid(),
  operation: GitWorkspaceOperation,
  credentialProfileId: z.string().min(1).max(128),
  commitMessage: optStr(5000),
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
  ReleaseWorkspaceWriterMessage,
  BindLinkedWorkspaceMessage,
  InspectWorkspaceSourceMessage,
  CleanupLegacyWorkspaceMessage,
  GitCredentialUpsertMessage,
  GitCredentialTestMessage,
  GitCredentialDeleteMessage,
  WorkspaceImportGitMessage,
  GitWorkspaceOperationMessage,
]);

export type WsMessageType = z.infer<typeof WsMessage>;
export type GitCredentialProviderType = z.infer<typeof GitCredentialProvider>;
export type GitCredentialAuthKindType = z.infer<typeof GitCredentialAuthKind>;
export type GitCredentialProfileType = z.infer<typeof GitCredentialProfile>;
export type SealedSecretEnvelopeType = z.infer<typeof SealedSecretEnvelope>;
export type GitCredentialUpsertMessageType = z.infer<typeof GitCredentialUpsertMessage>;
export type GitCredentialTestMessageType = z.infer<typeof GitCredentialTestMessage>;
export type GitCredentialDeleteMessageType = z.infer<typeof GitCredentialDeleteMessage>;
export type WorkspaceImportGitMessageType = z.infer<typeof WorkspaceImportGitMessage>;
export type GitWorkspaceOperationType = z.infer<typeof GitWorkspaceOperation>;
export type GitWorkspaceOperationMessageType = z.infer<typeof GitWorkspaceOperationMessage>;
