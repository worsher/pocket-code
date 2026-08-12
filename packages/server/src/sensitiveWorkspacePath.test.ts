import { describe, expect, it } from "vitest";
import {
  assertWorkspacePathNotSensitive,
  isLegacyCredentialArtifact,
  isSensitiveWorkspacePath,
} from "./sensitiveWorkspacePath.js";

describe("sensitive workspace path policy", () => {
  it.each([
    ".git-credentials",
    "nested/.git-credentials",
    ".gitconfig",
    ".netrc",
    ".git/config",
    ".git/HEAD",
    ".git/pocket-code/snapidx",
    ".ssh/id_ed25519",
    "nested\\.netrc",
  ])("blocks %s", (path) => {
    expect(isSensitiveWorkspacePath(path)).toBe(true);
    expect(() => assertWorkspacePathNotSensitive(path)).toThrow("Sensitive workspace path");
  });

  it.each(["src/index.ts", ".env.example", "config/git.ts", "git/config.ts"])(
    "allows ordinary project path %s",
    (path) => expect(isSensitiveWorkspacePath(path)).toBe(false)
  );

  it("does not classify .git/config as a removable legacy artifact", () => {
    expect(isSensitiveWorkspacePath(".git/config")).toBe(true);
    expect(isLegacyCredentialArtifact(".git/config")).toBe(false);
    expect(isLegacyCredentialArtifact(".git-credentials")).toBe(true);
    expect(isLegacyCredentialArtifact("nested/.git-credentials")).toBe(false);
    expect(isLegacyCredentialArtifact(".ssh/id_ed25519")).toBe(false);
  });
});
