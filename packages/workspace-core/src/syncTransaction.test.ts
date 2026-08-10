import { describe, expect, it, vi } from "vitest";
import {
  createSyncTransactionJournal,
  runSyncTransaction,
  type SyncTransactionAdapter,
} from "./syncTransaction.js";

function adapter(overrides: Partial<SyncTransactionAdapter> = {}): SyncTransactionAdapter {
  return {
    persistJournal: vi.fn(async () => undefined),
    prepare: vi.fn(async () => undefined),
    transfer: vi.fn(async () => undefined),
    verify: vi.fn(async (journal) => journal.expectedSnapshot),
    apply: vi.fn(async (journal) => journal.expectedSnapshot),
    commit: vi.fn(async () => undefined),
    cleanup: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("sync transaction journal", () => {
  it("advances the base only after verified apply", async () => {
    const subject = adapter();
    const journal = createSyncTransactionJournal({
      transactionId: "tx-1",
      edgeId: "local:remote",
      baseSnapshot: "old",
      expectedSnapshot: "next",
    });
    const result = await runSyncTransaction(journal, subject);
    expect(result).toMatchObject({
      phase: "committed",
      verifiedSnapshot: "next",
      appliedSnapshot: "next",
    });
    expect(subject.commit).toHaveBeenCalledTimes(1);
    expect(subject.cleanup).toHaveBeenCalledTimes(1);
  });

  it("does not commit when verification fails", async () => {
    const subject = adapter({ verify: vi.fn(async () => "corrupt") });
    const journal = createSyncTransactionJournal({
      transactionId: "tx-2",
      edgeId: "local:remote",
      baseSnapshot: "old",
      expectedSnapshot: "next",
    });
    await expect(runSyncTransaction(journal, subject)).rejects.toThrow("verification mismatch");
    expect(subject.commit).not.toHaveBeenCalled();
    expect(subject.persistJournal).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: "failed", baseSnapshot: "old" })
    );
  });

  it("resumes a committed journal after a crash before catalog persistence", async () => {
    const subject = adapter();
    const journal = {
      ...createSyncTransactionJournal({
        transactionId: "tx-3",
        edgeId: "local:remote",
        baseSnapshot: "old",
        expectedSnapshot: "next",
      }),
      phase: "committed" as const,
      verifiedSnapshot: "next",
      appliedSnapshot: "next",
    };
    await runSyncTransaction(journal, subject);
    expect(subject.prepare).not.toHaveBeenCalled();
    expect(subject.commit).toHaveBeenCalledTimes(1);
  });
});
