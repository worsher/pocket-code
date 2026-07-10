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

// ── WS 隧道帧(P7 HMR:dev server 的 WebSocket 经隧道透传) ──

export const TunnelWsOpen = z.object({
  type: z.literal("tunnel-ws-open"),
  tunnelId: z.string().min(1).max(64),
  port: z.number().int().min(1).max(65535),
  path: z.string().max(8192),
  /** 白名单透传:cookie / sec-websocket-protocol / user-agent;origin 已由 relay 重写 */
  headers: z.record(z.string()),
});

export const TunnelWsOpened = z.object({
  type: z.literal("tunnel-ws-opened"),
  tunnelId: z.string(),
  /** daemon 侧协商出的子协议 */
  protocol: z.string().optional(),
});

export const TunnelWsData = z.object({
  type: z.literal("tunnel-ws-data"),
  tunnelId: z.string(),
  /** 文本消息直传;binary 时为 base64 */
  data: z.string(),
  binary: z.boolean().optional(),
});

export const TunnelWsClose = z.object({
  type: z.literal("tunnel-ws-close"),
  tunnelId: z.string(),
  /** 原始关闭码(调用 ws.close 前由消费方夹紧) */
  code: z.number().int().optional(),
  reason: z.string().max(512).optional(),
});

export const TunnelFrame = z.discriminatedUnion("type", [
  TunnelRequest,
  TunnelResponse,
  TunnelChunk,
  TunnelEnd,
  TunnelWsOpen,
  TunnelWsOpened,
  TunnelWsData,
  TunnelWsClose,
]);

export type TunnelRequestType = z.infer<typeof TunnelRequest>;
export type TunnelResponseType = z.infer<typeof TunnelResponse>;
export type TunnelChunkType = z.infer<typeof TunnelChunk>;
export type TunnelEndType = z.infer<typeof TunnelEnd>;
export type TunnelWsOpenType = z.infer<typeof TunnelWsOpen>;
export type TunnelWsOpenedType = z.infer<typeof TunnelWsOpened>;
export type TunnelWsDataType = z.infer<typeof TunnelWsData>;
export type TunnelWsCloseType = z.infer<typeof TunnelWsClose>;
export type TunnelFrameType = z.infer<typeof TunnelFrame>;
