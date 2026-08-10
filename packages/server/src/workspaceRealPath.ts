import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

function isContained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function assertContained(root: string, target: string): void {
  if (!isContained(root, target)) {
    throw new Error("Workspace path resolves outside the workspace");
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

/**
 * Resolve a backend path and verify its real filesystem ancestry. Existing
 * symlinks may be used only when their resolved target remains in workspace.
 */
export async function resolveWorkspaceRealPath(
  workspace: string,
  requestedPath: string,
  options: { allowMissing: boolean }
): Promise<string> {
  const lexicalRoot = resolve(workspace);
  const candidate = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(lexicalRoot, requestedPath);
  assertContained(lexicalRoot, candidate);

  const realRoot = await realpath(lexicalRoot);
  let probe = candidate;

  while (true) {
    try {
      const realProbe = await realpath(probe);
      assertContained(realRoot, realProbe);
      return candidate;
    } catch (error) {
      if (!options.allowMissing || errorCode(error) !== "ENOENT") throw error;

      // realpath(2) reports ENOENT for a dangling symlink. lstat distinguishes
      // that unsafe case from an ordinary not-yet-created path component.
      try {
        await lstat(probe);
        throw new Error("Workspace path contains an unresolved symbolic link");
      } catch (lstatError) {
        if (errorCode(lstatError) !== "ENOENT") throw lstatError;
      }

      if (probe === lexicalRoot) {
        throw new Error("Workspace root does not exist");
      }
      const parent = dirname(probe);
      if (parent === probe) throw new Error("Workspace path has no existing parent");
      probe = parent;
    }
  }
}
