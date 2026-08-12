import { posix } from "node:path";

/**
 * Credentials and private Git implementation details that must never cross a
 * workspace content boundary.  This policy is intentionally independent from
 * .gitignore: ignore files are user-controlled and do not provide a security
 * boundary.
 */
const SENSITIVE_FILE_NAMES = new Set([
  ".git-credentials",
  ".gitconfig",
  ".netrc",
  ".pocket-code-credentials",
]);

const SENSITIVE_PATHS = new Set([
  ".git/config",
  ".git/credentials",
]);

const SENSITIVE_DIRECTORY_SEGMENTS = new Set([
  ".git",
  ".ssh",
  ".pocket-code-credentials",
]);

function normalizeForPolicy(input: string): string {
  if (input.includes("\0")) return "__invalid__";
  const slashPath = input.replaceAll("\\", "/").replace(/^\/+/, "");
  const normalized = posix.normalize(slashPath || ".");
  return normalized === "." ? "" : normalized.replace(/^\.\//, "");
}

/** Returns true for paths whose content or directory listing is sensitive. */
export function isSensitiveWorkspacePath(input: string): boolean {
  const normalized = normalizeForPolicy(input).toLowerCase();
  if (!normalized || normalized === "__invalid__") return normalized === "__invalid__";
  if (SENSITIVE_PATHS.has(normalized)) return true;
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => SENSITIVE_FILE_NAMES.has(segment))) return true;
  if (segments.some((segment) => SENSITIVE_DIRECTORY_SEGMENTS.has(segment))) return true;
  return false;
}

export function assertWorkspacePathNotSensitive(input: string): void {
  if (isSensitiveWorkspacePath(input)) {
    throw new Error("Sensitive workspace path is not accessible");
  }
}

/**
 * Basename-oriented patterns used by Git's exclude engine.  The explicit
 * directory forms cover credentials accidentally placed below a subdirectory.
 */
export const SENSITIVE_GIT_EXCLUDES = [
  ".git-credentials",
  "**/.git-credentials",
  ".gitconfig",
  "**/.gitconfig",
  ".netrc",
  "**/.netrc",
  ".ssh/",
  "**/.ssh/",
  ".pocket-code-credentials/",
  "**/.pocket-code-credentials/",
] as const;

/** Legacy plaintext artifacts that can be safely deleted during migration. */
export function isLegacyCredentialArtifact(input: string): boolean {
  const normalized = normalizeForPolicy(input).toLowerCase();
  // Older Pocket Code versions generated only these two files at the
  // workspace root.  Do not delete a user's nested files or their own .ssh.
  return normalized === ".git-credentials" || normalized === ".gitconfig";
}
