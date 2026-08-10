import { parseStorageKey } from "./ids.js";
import type { StorageKey } from "./types.js";

export interface ManagedWorkspaceRelativeRoots {
  readonly projectRoot: string;
  readonly worktreeRoot: string;
  readonly stateRoot: string;
  readonly cacheRoot: string;
}

/**
 * Returns catalog-relative POSIX roots. Platform resolvers join these segments
 * to a trusted Pocket Code data root using native path/URI APIs.
 */
export function getManagedWorkspaceRelativeRoots(
  storageKey: StorageKey | string
): ManagedWorkspaceRelativeRoots {
  const safeStorageKey = parseStorageKey(storageKey);
  const projectRoot = `projects/${safeStorageKey}`;
  return {
    projectRoot,
    worktreeRoot: `${projectRoot}/worktree`,
    stateRoot: `${projectRoot}/state`,
    cacheRoot: `${projectRoot}/cache`,
  };
}
