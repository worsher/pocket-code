import { parseReplicaId } from "./ids.js";
import type { ReplicaId, WriterLease } from "./types.js";

export function isWriterLeaseActive(lease: WriterLease, now: Date = new Date()): boolean {
  return !lease.expiresAt || Date.parse(lease.expiresAt) > now.getTime();
}

export function acquireWriterLease(args: {
  current?: WriterLease;
  replicaId: ReplicaId | string;
  now?: Date;
  ttlMs?: number;
}): WriterLease {
  const now = args.now ?? new Date();
  const replicaId = parseReplicaId(args.replicaId);
  if (
    args.current &&
    isWriterLeaseActive(args.current, now) &&
    args.current.holderReplicaId !== replicaId
  ) {
    throw new Error(`Writer lease is held by replica ${args.current.holderReplicaId}`);
  }
  const generation = args.current?.generation ?? 1;
  return {
    holderReplicaId: replicaId,
    generation,
    acquiredAt: now.toISOString(),
    ...(args.ttlMs ? { expiresAt: new Date(now.getTime() + args.ttlMs).toISOString() } : {}),
  };
}

export function handoffWriterLease(args: {
  current: WriterLease;
  fromReplicaId: ReplicaId | string;
  toReplicaId: ReplicaId | string;
  expectedGeneration: number;
  now?: Date;
  ttlMs?: number;
}): WriterLease {
  const fromReplicaId = parseReplicaId(args.fromReplicaId);
  const toReplicaId = parseReplicaId(args.toReplicaId);
  if (args.current.holderReplicaId !== fromReplicaId) {
    throw new Error("Writer handoff source does not hold the lease");
  }
  if (args.current.generation !== args.expectedGeneration) {
    throw new Error("Stale writer handoff generation");
  }
  const now = args.now ?? new Date();
  return {
    holderReplicaId: toReplicaId,
    generation: args.current.generation + 1,
    acquiredAt: now.toISOString(),
    ...(args.ttlMs ? { expiresAt: new Date(now.getTime() + args.ttlMs).toISOString() } : {}),
  };
}
