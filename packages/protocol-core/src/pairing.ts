// ── Pairing Protocol Schemas ──────────────────────────────
// Defines the pairing flow messages between App, Relay, and Daemon.
// Pairing replaces anonymous registration for the relay mode.

import { z } from "zod";

// ── App → Relay → Daemon: Pairing Request ─────────────

export const PairRequest = z.object({
  type: z.literal("pair-request"),
  pairingCode: z.string().length(8).regex(/^[0-9A-HJ-NP-Z]{8}$/),
  deviceId: z.string().min(1).max(128),
  deviceName: z.string().min(1).max(64),
  /** Target machine (required when multiple daemons are online) */
  machineId: z.string().min(1).max(128).optional(),
});

export type PairRequestType = z.infer<typeof PairRequest>;

// ── Daemon → Relay → App: Pairing Response ────────────

export const PairResponseSuccess = z.object({
  type: z.literal("pair-response"),
  success: z.literal(true),
  token: z.string(),
  machineId: z.string(),
  machineName: z.string(),
});

export const PairResponseError = z.object({
  type: z.literal("pair-response"),
  success: z.literal(false),
  error: z.string(),
});

export const PairResponse = z.discriminatedUnion("success", [
  PairResponseSuccess,
  PairResponseError,
]);

export type PairResponseType = z.infer<typeof PairResponse>;

// ── Daemon → Relay: Registration ──────────────────────

export const DaemonRegister = z.object({
  type: z.literal("daemon-register"),
  machineId: z.string().min(1).max(128),
  machineName: z.string().min(1).max(64),
  version: z.string().optional(),
  /** HMAC-SHA256(machineId + timestamp, RELAY_SECRET) for authenticated registration */
  authToken: z.string().optional(),
  /** Unix timestamp (ms) used in HMAC computation, for replay prevention */
  timestamp: z.number().optional(),
});

export type DaemonRegisterType = z.infer<typeof DaemonRegister>;

// ── Daemon → Relay: Heartbeat ─────────────────────────

export const DaemonHeartbeat = z.object({
  type: z.literal("daemon-heartbeat"),
  machineId: z.string().min(1).max(128),
  timestamp: z.number(),
});

export type DaemonHeartbeatType = z.infer<typeof DaemonHeartbeat>;

// ── App → Relay: List online machines ─────────────────

export const ListMachines = z.object({
  type: z.literal("list-machines"),
});

export type ListMachinesType = z.infer<typeof ListMachines>;

export const MachineInfo = z.object({
  machineId: z.string(),
  machineName: z.string(),
  online: z.boolean(),
  lastSeen: z.number().optional(),
});

export type MachineInfoType = z.infer<typeof MachineInfo>;

export const ListMachinesResponse = z.object({
  type: z.literal("machines-list"),
  machines: z.array(MachineInfo),
});

export type ListMachinesResponseType = z.infer<typeof ListMachinesResponse>;
