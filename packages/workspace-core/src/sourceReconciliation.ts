import type { SourceIdentity } from "./types.js";

export type CopySourceDecision =
  | "unchanged"
  | "converged"
  | "source-ahead"
  | "workspace-ahead"
  | "conflict";

/**
 * Classifies an explicitly requested copy-source operation against the
 * snapshot recorded by the last import/export. Copy imports never silently
 * merge: when both sides changed to different snapshots the caller must ask
 * the user which side is allowed to overwrite the other.
 */
export function classifyCopySourceReconciliation(args: {
  importedSnapshot: string;
  workspaceSnapshot: string;
  sourceSnapshot: string;
}): CopySourceDecision {
  if (args.workspaceSnapshot === args.sourceSnapshot) {
    return args.workspaceSnapshot === args.importedSnapshot ? "unchanged" : "converged";
  }
  const workspaceChanged = args.workspaceSnapshot !== args.importedSnapshot;
  const sourceChanged = args.sourceSnapshot !== args.importedSnapshot;
  if (workspaceChanged && sourceChanged) return "conflict";
  if (sourceChanged) return "source-ahead";
  if (workspaceChanged) return "workspace-ahead";
  return "unchanged";
}

/** Refreshes the advisory content key without discarding stable locator IDs. */
export function refreshSourceIdentityContent(
  identity: SourceIdentity,
  snapshot: string
): SourceIdentity {
  const weakKeys = identity.weakKeys.filter((key) => {
    try {
      const parsed = JSON.parse(key);
      return !Array.isArray(parsed) || parsed[0] !== "content";
    } catch {
      return true;
    }
  });
  weakKeys.push(JSON.stringify(["content", snapshot.toLowerCase()]));
  return { ...identity, weakKeys: [...new Set(weakKeys)].sort() };
}
