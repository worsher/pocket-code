import type { WorkspaceScope } from "./types.js";

export function isSameWorkspaceScope(expected: WorkspaceScope, actual: WorkspaceScope): boolean {
  return (
    expected.projectId === actual.projectId &&
    expected.replicaId === actual.replicaId &&
    expected.sessionId === actual.sessionId &&
    expected.workspaceGeneration === actual.workspaceGeneration
  );
}
