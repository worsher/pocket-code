// ── WebSocket Message Schemas (zod) ──────────────────────
// Validates all incoming WebSocket messages to prevent malformed input.
// NOTE: Client (React Native) may send `null` for optional fields (from useState),
// so we use .nullable() alongside .optional() where needed.

import { z } from "zod";

/** Helper: accept string, undefined, or null — coerce null to undefined */
const optStr = (maxLen = 1024) =>
    z.string().max(maxLen).optional().nullable().transform(v => v ?? undefined);

export const RegisterMessage = z.object({
    type: z.literal("register"),
    deviceId: z.string().min(1).max(128),
});

export const InitMessage = z.object({
    type: z.literal("init"),
    token: optStr(),
    sessionId: optStr(128),
    projectId: optStr(128),
    model: optStr(64),
    customPrompt: optStr(10000),
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
        .transform(v => v ?? undefined),
});

export const MessageMessage = z.object({
    type: z.literal("message"),
    content: z.string().min(1).max(100000),
    model: optStr(64),
    customPrompt: optStr(10000),
    rewindTo: z.number().int().min(0).optional().nullable().transform(v => v ?? undefined),
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
        .transform(v => v ?? undefined),
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
    limit: z.number().int().min(1).max(200).optional().nullable().transform(v => v ?? undefined),
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

/** Discriminated union of all valid WebSocket messages */
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
]);

export type WsMessageType = z.infer<typeof WsMessage>;
