// ── Relay Envelope Schemas ────────────────────────────────
// Wraps opaque payloads for transit through the relay layer.
// 中继不认识业务协议:payload 一律 z.record(z.unknown()),
// 业务校验由隧道两端(如 daemon 的 messageHandler)兜底。

import { z } from "zod";

// ── App → Relay: Request envelope ─────────────────────

export const RelayRequest = z.object({
  type: z.literal("relay-request"),
  /** Device JWT issued by the target daemon during pairing */
  token: z.string().min(1),
  /** Target machine */
  machineId: z.string().min(1).max(128),
  /** Correlation ID for request-response matching */
  requestId: z.string().min(1).max(128),
  /** Opaque business payload (validated by the receiving end) */
  payload: z.record(z.unknown()),
});

export type RelayRequestType = z.infer<typeof RelayRequest>;

// ── Relay → Daemon: Forwarded request ─────────────────

export const ForwardRequest = z.object({
  type: z.literal("forward-request"),
  /** The device JWT for daemon-side verification */
  token: z.string().min(1),
  requestId: z.string().min(1).max(128),
  payload: z.record(z.unknown()),
});

export type ForwardRequestType = z.infer<typeof ForwardRequest>;

// ── Daemon → Relay → App: Response envelope ───────────

export const ForwardResponse = z.object({
  type: z.literal("forward-response"),
  requestId: z.string().min(1).max(128),
  payload: z.record(z.unknown()),
});

export type ForwardResponseType = z.infer<typeof ForwardResponse>;

export const RelayResponse = z.object({
  type: z.literal("relay-response"),
  requestId: z.string().min(1).max(128),
  payload: z.record(z.unknown()),
});

export type RelayResponseType = z.infer<typeof RelayResponse>;

// ── Daemon → Relay → App: Stream envelope ─────────────
// For streaming data (AI text deltas, tool calls, etc.)

export const ForwardStream = z.object({
  type: z.literal("forward-stream"),
  requestId: z.string().min(1).max(128),
  payload: z.record(z.unknown()),
});

export type ForwardStreamType = z.infer<typeof ForwardStream>;

export const RelayStream = z.object({
  type: z.literal("relay-stream"),
  requestId: z.string().min(1).max(128),
  payload: z.record(z.unknown()),
});

export type RelayStreamType = z.infer<typeof RelayStream>;
