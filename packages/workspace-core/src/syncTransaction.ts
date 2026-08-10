import { canAdvanceSyncBase, canTransitionSyncPhase } from "./syncState.js";
import type { SyncPhase, SyncTransactionJournal } from "./types.js";

export interface SyncTransactionAdapter {
  persistJournal(journal: SyncTransactionJournal): Promise<void>;
  prepare(journal: SyncTransactionJournal): Promise<void>;
  transfer(journal: SyncTransactionJournal): Promise<void>;
  verify(journal: SyncTransactionJournal): Promise<string>;
  apply(journal: SyncTransactionJournal): Promise<string>;
  /** The only callback authorized to advance an edge base snapshot. */
  commit(journal: SyncTransactionJournal): Promise<void>;
  cleanup(journal: SyncTransactionJournal): Promise<void>;
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function withPhase(
  journal: SyncTransactionJournal,
  phase: SyncPhase,
  now: () => Date,
  updates: Partial<SyncTransactionJournal> = {}
): SyncTransactionJournal {
  if (!canTransitionSyncPhase(journal.phase, phase)) {
    throw new Error(`Invalid sync phase transition: ${journal.phase} -> ${phase}`);
  }
  return { ...journal, ...updates, phase, updatedAt: nowIso(now), error: undefined };
}

export function createSyncTransactionJournal(args: {
  transactionId: string;
  edgeId: string;
  baseSnapshot: string | null;
  expectedSnapshot: string;
  now?: Date;
}): SyncTransactionJournal {
  const timestamp = (args.now ?? new Date()).toISOString();
  return {
    version: 1,
    transactionId: args.transactionId,
    edgeId: args.edgeId,
    phase: "preparing",
    baseSnapshot: args.baseSnapshot,
    expectedSnapshot: args.expectedSnapshot,
    verifiedSnapshot: null,
    appliedSnapshot: null,
    startedAt: timestamp,
    updatedAt: timestamp,
  };
}

/**
 * Runs or resumes an idempotent sync transaction. A committed journal is kept
 * until the catalog edge is durably advanced and cleanup succeeds, allowing a
 * crash between workspace apply and catalog persistence to recover safely.
 */
export async function runSyncTransaction(
  initial: SyncTransactionJournal,
  adapter: SyncTransactionAdapter,
  now: () => Date = () => new Date()
): Promise<SyncTransactionJournal> {
  let journal = initial;
  try {
    if (journal.phase === "preparing") {
      await adapter.persistJournal(journal);
      await adapter.prepare(journal);
      journal = withPhase(journal, "transferring", now);
      await adapter.persistJournal(journal);
    }
    if (journal.phase === "transferring") {
      await adapter.transfer(journal);
      journal = withPhase(journal, "verifying", now);
      await adapter.persistJournal(journal);
    }
    if (journal.phase === "verifying") {
      const verifiedSnapshot = await adapter.verify(journal);
      if (verifiedSnapshot !== journal.expectedSnapshot) {
        throw new Error(
          `Sync verification mismatch: expected ${journal.expectedSnapshot}, got ${verifiedSnapshot}`
        );
      }
      journal = withPhase(journal, "applying", now, { verifiedSnapshot });
      await adapter.persistJournal(journal);
    }
    if (journal.phase === "applying") {
      const appliedSnapshot = await adapter.apply(journal);
      if (appliedSnapshot !== journal.expectedSnapshot) {
        throw new Error(
          `Sync apply mismatch: expected ${journal.expectedSnapshot}, got ${appliedSnapshot}`
        );
      }
      journal = withPhase(journal, "committed", now, { appliedSnapshot });
      await adapter.persistJournal(journal);
    }
    if (journal.phase !== "committed" || !canAdvanceSyncBase(journal)) {
      throw new Error(`Sync transaction cannot commit from phase ${journal.phase}`);
    }
    await adapter.commit(journal);
    await adapter.cleanup(journal);
    return journal;
  } catch (error) {
    const message = error instanceof Error ? error.message : "sync transaction failed";
    if (journal.phase !== "committed") {
      const target: SyncPhase = journal.phase === "applying" ? "recovery-required" : "failed";
      if (canTransitionSyncPhase(journal.phase, target)) {
        journal = {
          ...journal,
          phase: target,
          updatedAt: nowIso(now),
          error: message,
        };
        await adapter.persistJournal(journal).catch(() => undefined);
      }
    }
    throw error;
  }
}
