import { homedir } from "os";
import { isAbsolute, join, relative, resolve } from "path";
import { pathToFileURL } from "url";
import {
  getManagedWorkspaceRelativeRoots,
  isUuid,
  parseLegacyProjectId,
  parseProjectId,
  parseReplicaId,
  type WorkspaceHandle,
} from "@pocket-code/workspace-core";
import { ensureWorkspaceProject } from "./db.js";

export interface WorkspaceRootRequest {
  sessionId: string;
  projectId?: string;
  userId?: string;
}

export interface V2WorkspaceRequest extends WorkspaceRootRequest {
  projectId: string;
  userId: string;
}

function assertContained(root: string, target: string): string {
  const rel = relative(resolve(root), resolve(target));
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return resolve(target);
  throw new Error("Resolved workspace is outside its storage root");
}

/**
 * Resolve a server workspace without ever using a new client project UUID as a
 * path segment. Legacy roots remain read-compatible until staged migration.
 */
export function getWorkspaceRoot(request: WorkspaceRootRequest): string {
  const { sessionId, projectId, userId } = request;
  if (projectId) {
    if (isUuid(projectId)) {
      if (!userId) throw new Error("User ID is required for a v2 project workspace");
      return getWorkspaceHandle({ sessionId, projectId, userId }).worktreeRoot;
    }

    const legacyId = parseLegacyProjectId(projectId);
    const legacyProjectsRoot =
      process.env.PROJECTS_ROOT || resolve(join(homedir(), ".pocket-code", "projects"));
    return assertContained(legacyProjectsRoot, join(legacyProjectsRoot, legacyId, "workspace"));
  }

  const safeSessionId = parseLegacyProjectId(sessionId);
  const legacySessionsRoot =
    process.env.WORKSPACE_ROOT || resolve(join(homedir(), ".pocket-code", "workspaces"));
  return assertContained(legacySessionsRoot, join(legacySessionsRoot, safeSessionId));
}

export function getWorkspaceHandle(request: V2WorkspaceRequest): WorkspaceHandle {
  const projectId = parseProjectId(request.projectId);
  const catalogEntry = ensureWorkspaceProject(request.userId, projectId);
  const dataRoot =
    process.env.POCKET_CODE_DATA_ROOT || resolve(join(homedir(), ".pocket-code", "v2"));
  const roots = getManagedWorkspaceRelativeRoots(catalogEntry.storageKey);
  const worktreeRoot = assertContained(dataRoot, join(dataRoot, roots.worktreeRoot));
  const stateRoot = assertContained(dataRoot, join(dataRoot, roots.stateRoot));
  const cacheRoot = assertContained(dataRoot, join(dataRoot, roots.cacheRoot));

  return {
    projectId,
    replicaId: parseReplicaId(catalogEntry.replicaId),
    generation: catalogEntry.generation,
    storageUri: pathToFileURL(worktreeRoot).href,
    shellPath: worktreeRoot,
    worktreeRoot,
    stateRoot,
    cacheRoot,
    capabilities: {
      read: true,
      write: true,
      execute: true,
      syncBack: true,
    },
  };
}
