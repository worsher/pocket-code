import { isAbsolute, relative, resolve } from "path";
import { normalizeWorkspaceRelativePath } from "@pocket-code/workspace-core";
import { resolveWorkspaceRealPath } from "./workspaceRealPath.js";

export function resolveWorkspaceEntry(workspace: string, relativePath: string): string {
  const safePath = normalizeWorkspaceRelativePath(relativePath);
  const target = resolve(workspace, safePath === "." ? "" : safePath);
  const rel = relative(resolve(workspace), target);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return target;
  }
  throw new Error("Invalid workspace path");
}

/** Lexical validation plus realpath ancestry validation for filesystem I/O. */
export async function resolveWorkspaceEntryChecked(
  workspace: string,
  relativePath: string,
  options: { allowMissing: boolean }
): Promise<string> {
  const lexicalPath = resolveWorkspaceEntry(workspace, relativePath);
  return resolveWorkspaceRealPath(workspace, lexicalPath, options);
}
