import { describe, expect, it } from "vitest";
import { isSensitiveGitContentPath } from "./gitSensitivePath";

describe("mobile Git sensitive paths", () => {
  it.each([
    ".git-credentials",
    "nested/.gitconfig",
    ".netrc",
    ".ssh/id_ed25519",
    ".git/config",
    "./nested/.pocket-code-credentials/token",
    "nested/.ssh/id_rsa",
    "nested\\.netrc",
  ])("blocks %s", (path) => {
    expect(isSensitiveGitContentPath(path)).toBe(true);
  });

  it.each(["src/index.ts", ".env.example", "config/git.ts"])("allows %s", (path) => {
    expect(isSensitiveGitContentPath(path)).toBe(false);
  });
});
