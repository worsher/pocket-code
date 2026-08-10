import { parseCatalogProjectKey, parseReplicaId } from "./ids.js";
import type { WorkspaceScope } from "./types.js";

export interface WorkspaceScopeInput {
  readonly projectId: string;
  readonly replicaId: string;
  readonly sessionId: string;
  readonly workspaceGeneration: number;
}

export function createWorkspaceScope(input: WorkspaceScopeInput): WorkspaceScope {
  if (!input.sessionId.trim()) throw new Error("Workspace session ID must not be empty");
  if (!Number.isInteger(input.workspaceGeneration) || input.workspaceGeneration < 1) {
    throw new Error("Workspace generation must be a positive integer");
  }
  return {
    projectId: parseCatalogProjectKey(input.projectId),
    replicaId: parseReplicaId(input.replicaId),
    sessionId: input.sessionId,
    workspaceGeneration: input.workspaceGeneration,
  };
}

export function isSameWorkspaceScope(expected: WorkspaceScope, actual: WorkspaceScope): boolean {
  return (
    expected.projectId === actual.projectId &&
    expected.replicaId === actual.replicaId &&
    expected.sessionId === actual.sessionId &&
    expected.workspaceGeneration === actual.workspaceGeneration
  );
}
