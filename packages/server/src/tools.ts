import { resolve, join } from "path";
import { homedir } from "os";

/**
 * Get the workspace root for a session or project.
 * - With projectId: ~/.pocket-code/projects/{projectId}/workspace (shared across sessions)
 * - Without projectId: ~/.pocket-code/workspaces/{sessionId} (legacy, per-session)
 */
export function getWorkspaceRoot(sessionId: string, projectId?: string): string {
  if (projectId) {
    const base =
      process.env.PROJECTS_ROOT ||
      resolve(join(homedir(), ".pocket-code", "projects"));
    return resolve(join(base, projectId, "workspace"));
  }
  const base =
    process.env.WORKSPACE_ROOT ||
    resolve(join(homedir(), ".pocket-code", "workspaces"));
  return resolve(join(base, sessionId));
}
