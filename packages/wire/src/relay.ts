// ── Relay Envelope Schemas ────────────────────────────────
// Wraps business messages for transit through the relay layer.

import { z } from "zod";
import { WsMessage, type WsMessageType } from "./messages.js";

// ── App → Relay: Request envelope ─────────────────────

export const RelayRequest = z.object({
  type: z.literal("relay-request"),
  /** Device JWT issued by the target daemon during pairing */
  token: z.string().min(1),
  /** Target machine */
  machineId: z.string().min(1).max(128),
  /** Correlation ID for request-response matching */
  requestId: z.string().min(1).max(128),
  /** The actual business message payload */
  payload: WsMessage,
});

export type RelayRequestType = z.infer<typeof RelayRequest>;

// ── Relay → Daemon: Forwarded request ─────────────────

export const ForwardRequest = z.object({
  type: z.literal("forward-request"),
  /** The device JWT for daemon-side verification */
  token: z.string().min(1),
  requestId: z.string().min(1).max(128),
  payload: WsMessage,
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
