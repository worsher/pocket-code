const SENSITIVE_FILE_NAMES = new Set([
  ".git-credentials",
  ".gitconfig",
  ".netrc",
  ".pocket-code-credentials",
]);

const SENSITIVE_DIRECTORY_NAMES = new Set([".git", ".ssh", ".pocket-code-credentials"]);

/** Project content that must never be staged or synchronized by the App. */
export function isSensitiveGitContentPath(value: string): boolean {
  if (!value || value.includes("\0")) return value.includes("\0");
  const normalized = value
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .replace(/^\.\//, "")
    .toLowerCase();
  const segments = normalized.split("/").filter(Boolean);
  return (
    segments.some((segment) => SENSITIVE_FILE_NAMES.has(segment)) ||
    segments.some((segment) => SENSITIVE_DIRECTORY_NAMES.has(segment))
  );
}
