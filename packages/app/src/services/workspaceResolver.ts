import { Directory, Paths } from "expo-file-system";
import {
  getManagedWorkspaceRelativeRoots,
  parseLegacyProjectId,
  parseProjectId,
  parseReplicaId,
  parseStorageKey,
  type WorkspaceHandle,
} from "@pocket-code/workspace-core";
import type { Project } from "../store/projects";

function ensureDirectory(directory: Directory): void {
  if (!directory.exists) directory.create({ idempotent: true, intermediates: true });
}

function nativePathFromFileUri(uri: string): string | undefined {
  if (!uri.startsWith("file://")) return undefined;
  return decodeURIComponent(uri.slice("file://".length));
}

function directoryFromRelativeRoot(root: Directory, relativeRoot: string): Directory {
  return new Directory(root, ...relativeRoot.split("/"));
}

export function getMobileV2Root(): Directory {
  return new Directory(Paths.document, "pocket-code", "v2");
}

export function ensureMobileStorageLayout(): Directory {
  const root = getMobileV2Root();
  ensureDirectory(root);
  for (const name of ["catalog", "projects", "runtime", "staging", "trash"]) {
    ensureDirectory(new Directory(root, name));
  }
  return root;
}

/** Resolve and create the managed roots for a v2 mobile replica. */
export function ensureMobileWorkspaceHandle(project: Project): WorkspaceHandle {
  if (project.localReplica.layout !== "v2") {
    throw new Error(`Project ${project.id} still requires legacy workspace migration`);
  }

  const projectId = parseProjectId(project.id);
  const replicaId = parseReplicaId(project.localReplica.id);
  const storageKey = parseStorageKey(project.localReplica.storageKey);
  const relativeRoots = getManagedWorkspaceRelativeRoots(storageKey);
  const root = ensureMobileStorageLayout();
  const worktree = directoryFromRelativeRoot(root, relativeRoots.worktreeRoot);
  const state = directoryFromRelativeRoot(root, relativeRoots.stateRoot);
  const cache = directoryFromRelativeRoot(root, relativeRoots.cacheRoot);

  ensureDirectory(worktree);
  ensureDirectory(state);
  ensureDirectory(cache);

  return {
    projectId,
    replicaId,
    generation: project.localReplica.generation,
    storageUri: worktree.uri,
    shellPath: nativePathFromFileUri(worktree.uri),
    worktreeRoot: worktree.uri,
    stateRoot: state.uri,
    cacheRoot: cache.uri,
    capabilities: {
      read: true,
      write: true,
      execute: true,
      syncBack: true,
    },
  };
}

/**
 * Compatibility resolver used until the staged legacy migration runs. Unsafe
 * legacy IDs are rejected even if a corrupt catalog bypassed normal upgrade.
 */
export function getLegacyMobileWorkspaceRoot(project: Project): string {
  const layout = project.localReplica.layout;
  if (layout === "v2") return ensureMobileWorkspaceHandle(project).worktreeRoot;
  if (layout === "legacy-default") {
    if (project.id !== "default") throw new Error("Invalid legacy default project");
    return new Directory(Paths.document, "workspace").uri;
  }

  const legacyId = parseLegacyProjectId(project.id);
  return new Directory(Paths.document, "workspace", legacyId).uri;
}

export function getCatalogProjectWorkspaceRoot(project: Project): string {
  return project.localReplica.layout === "v2"
    ? ensureMobileWorkspaceHandle(project).worktreeRoot
    : getLegacyMobileWorkspaceRoot(project);
}
