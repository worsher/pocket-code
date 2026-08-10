const WINDOWS_DRIVE_PATTERN = /^[a-zA-Z]:/;
const URI_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

function assertSafeCandidate(candidate: string): void {
  if (candidate.includes("\0")) {
    throw new Error("Workspace path must not contain NUL bytes");
  }
  if (candidate.includes("\\")) {
    throw new Error("Workspace path must use forward slashes");
  }
  if (
    candidate.startsWith("/") ||
    WINDOWS_DRIVE_PATTERN.test(candidate) ||
    URI_SCHEME_PATTERN.test(candidate)
  ) {
    throw new Error("Workspace path must be relative");
  }

  for (const segment of candidate.split("/")) {
    if (segment === "..") {
      throw new Error("Workspace path must not traverse outside the worktree");
    }
  }
}

function assertEncodedFormsSafe(value: string): void {
  let candidate = value;

  // Check several decoding layers so a later URL/URI adapter cannot turn an
  // accepted value into ../ or an absolute path. The function returns the raw
  // filesystem-relative form; it does not decode user filenames.
  for (let depth = 0; depth < 4 && candidate.includes("%"); depth += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      throw new Error("Workspace path contains malformed URI encoding");
    }
    if (decoded === candidate) break;
    assertSafeCandidate(decoded);
    candidate = decoded;
  }
}

/**
 * Validates and normalizes a decoded, workspace-relative POSIX path.
 * Platform adapters must still enforce realpath/file-handle containment to
 * prevent symlink escapes.
 */
export function normalizeWorkspaceRelativePath(value: string): string {
  assertSafeCandidate(value);
  assertEncodedFormsSafe(value);

  const normalized = value
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");

  return normalized || ".";
}
