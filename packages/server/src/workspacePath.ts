import { isAbsolute, relative, resolve } from "path";
import { normalizeWorkspaceRelativePath } from "@pocket-code/workspace-core";

export function resolveWorkspaceEntry(workspace: string, relativePath: string): string {
  const safePath = normalizeWorkspaceRelativePath(relativePath);
  const target = resolve(workspace, safePath === "." ? "" : safePath);
  const rel = relative(resolve(workspace), target);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return target;
  }
  throw new Error("Invalid workspace path");
}
