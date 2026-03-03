// ── WebSocket Message Schemas (zod) ──────────────────────
// Validates all incoming WebSocket messages to prevent malformed input.

import { z } from "zod";

export const RegisterMessage = z.object({
    type: z.literal("register"),
    deviceId: z.string().min(1).max(128),
});

export const InitMessage = z.object({
    type: z.literal("init"),
    token: z.string().optional(),
    sessionId: z.string().max(128).optional(),
    projectId: z.string().max(128).optional(),
    model: z.string().max(64).optional(),
    customPrompt: z.string().max(10000).optional(),
    gitCredentials: z
        .array(
            z.object({
                platform: z.string(),
                host: z.string(),
                username: z.string(),
                token: z.string(),
            })
        )
        .optional(),
});

export const MessageMessage = z.object({
    type: z.literal("message"),
    content: z.string().min(1).max(100000),
    model: z.string().max(64).optional(),
    customPrompt: z.string().max(10000).optional(),
    rewindTo: z.number().int().min(0).optional(),
    images: z
        .array(
            z.object({
                base64: z.string(),
                mimeType: z.string(),
            })
        )
        .max(10)
        .optional(),
});

export const ToolExecMessage = z.object({
    type: z.literal("tool-exec"),
    toolName: z.string().min(1).max(64),
    args: z.record(z.unknown()),
    callId: z.string().optional(),
});

export const ListFilesMessage = z.object({
    type: z.literal("list-files"),
    path: z.string().max(1024).optional(),
    _reqId: z.string().optional(),
});

export const ReadFileMessage = z.object({
    type: z.literal("read-file"),
    path: z.string().min(1).max(1024),
    _reqId: z.string().optional(),
});

export const ListSessionsMessage = z.object({
    type: z.literal("list-sessions"),
    projectId: z.string().max(128).optional(),
    limit: z.number().int().min(1).max(200).optional(),
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
