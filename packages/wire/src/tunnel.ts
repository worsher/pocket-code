// ── HTTP 隧道帧(relay ↔ daemon) ────────────────────────────
// relay 反向 HTTP 代理:把手机对 /t/<machineId>/<port>/* 的请求经 daemon
// 隧道转给开发机 localhost:<port>,流式回传。帧在 daemon↔relay WS 上独立流动。

import { z } from "zod";

export const TunnelRequest = z.object({
  type: z.literal("tunnel-request"),
  tunnelId: z.string().min(1).max(64),
  port: z.number().int().min(1).max(65535),
  method: z.string().min(1).max(16),
  path: z.string().max(8192),
  headers: z.record(z.string()),
  /** 请求体(base64),GET/HEAD 无。 */
  body: z.string().optional(),
});

export const TunnelResponse = z.object({
  type: z.literal("tunnel-response"),
  tunnelId: z.string(),
  status: z.number().int(),
  headers: z.record(z.string()),
});

export const TunnelChunk = z.object({
  type: z.literal("tunnel-chunk"),
  tunnelId: z.string(),
  /** 响应体分片(base64)。 */
  data: z.string(),
});

export const TunnelEnd = z.object({
  type: z.literal("tunnel-end"),
  tunnelId: z.string(),
  error: z.string().optional(),
});

export const TunnelFrame = z.discriminatedUnion("type", [
  TunnelRequest,
  TunnelResponse,
  TunnelChunk,
  TunnelEnd,
]);

export type TunnelRequestType = z.infer<typeof TunnelRequest>;
export type TunnelResponseType = z.infer<typeof TunnelResponse>;
export type TunnelChunkType = z.infer<typeof TunnelChunk>;
export type TunnelEndType = z.infer<typeof TunnelEnd>;
export type TunnelFrameType = z.infer<typeof TunnelFrame>;
