import type { SyncCommitEvidence, SyncDecision, SyncPhase, SyncSnapshots } from "./types.js";

export function classifySyncState(snapshots: SyncSnapshots): SyncDecision {
  const { baseSnapshot, localSnapshot, remoteSnapshot } = snapshots;

  if (baseSnapshot === null) {
    if (localSnapshot === null && remoteSnapshot === null) return "unavailable";
    if (localSnapshot !== null && remoteSnapshot === null) return "push";
    if (localSnapshot === null && remoteSnapshot !== null) return "pull";
    return localSnapshot === remoteSnapshot ? "converged" : "conflict";
  }

  if (localSnapshot === null || remoteSnapshot === null) return "unavailable";
  if (localSnapshot === baseSnapshot && remoteSnapshot === baseSnapshot) return "noop";
  if (localSnapshot === remoteSnapshot) return "converged";
  if (remoteSnapshot === baseSnapshot) return "push";
  if (localSnapshot === baseSnapshot) return "pull";
  return "conflict";
}

const ALLOWED_PHASE_TRANSITIONS: Readonly<Record<SyncPhase, readonly SyncPhase[]>> = {
  idle: ["preparing"],
  preparing: ["transferring", "failed", "conflict"],
  transferring: ["verifying", "failed", "recovery-required"],
  verifying: ["applying", "failed", "conflict", "recovery-required"],
  applying: ["committed", "recovery-required"],
  committed: ["preparing", "idle"],
  failed: ["preparing", "idle"],
  conflict: ["preparing", "idle"],
  "recovery-required": ["preparing", "failed", "idle"],
};

export function canTransitionSyncPhase(from: SyncPhase, to: SyncPhase): boolean {
  return ALLOWED_PHASE_TRANSITIONS[from].includes(to);
}

/** A base snapshot advances only after verified data was atomically applied. */
export function canAdvanceSyncBase(evidence: SyncCommitEvidence): boolean {
  return (
    evidence.phase === "committed" &&
    evidence.verifiedSnapshot === evidence.expectedSnapshot &&
    evidence.appliedSnapshot === evidence.expectedSnapshot
  );
}
