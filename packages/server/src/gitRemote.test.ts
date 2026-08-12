import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedGitCredential } from "./gitCredentialVault.js";
import {
  assertGitRemoteMatchesProfile,
  redactSensitiveText,
  runGitWorkspaceOperation,
} from "./gitRemote.js";

const roots: string[] = [];
const credential: ResolvedGitCredential = {
  profile: {
    id: "gitlab-team",
    provider: "gitlab",
    authKind: "pat",
    origin: "https://git.example.com:8443",
    pathPrefix: "/gitlab/team-a",
    username: "developer",
  },
  secret: "sentinel-token",
  createdAt: 1,
  updatedAt: 1,
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Git remote policy", () => {
  it("matches exact origin, port, and path boundary", () => {
    expect(
      assertGitRemoteMatchesProfile(
        "https://git.example.com:8443/gitlab/team-a/project.git",
        credential.profile
      )
    ).toBe("https://git.example.com:8443/gitlab/team-a/project.git");
    expect(() =>
      assertGitRemoteMatchesProfile(
        "https://git.example.com/gitlab/team-a/project.git",
        credential.profile
      )
    ).toThrow(expect.objectContaining({ code: "host_mismatch" }));
    expect(() =>
      assertGitRemoteMatchesProfile(
        "https://git.example.com:8443/gitlab/team-ab/project.git",
        credential.profile
      )
    ).toThrow(expect.objectContaining({ code: "host_mismatch" }));
  });

  it("rejects embedded credentials and redacts secrets", () => {
    expect(() =>
      assertGitRemoteMatchesProfile(
        "https://user:token@git.example.com:8443/gitlab/team-a/project.git",
        credential.profile
      )
    ).toThrow(expect.objectContaining({ code: "invalid_request" }));
    expect(
      redactSensitiveText(
        "fatal https://user:pass@example.com token=abc sentinel-token",
        [credential.secret]
      )
    ).toBe("fatal https://[REDACTED]@example.com token=[REDACTED] [REDACTED]");
  });

  it.each([
    "https://git.example.com:8443/gitlab/team-a/%2e%2e/private.git",
    "https://git.example.com:8443/gitlab/team-a/%252e%252e/private.git",
    "https://git.example.com:8443/gitlab/team-a%2fother/repo.git",
  ])("rejects an ambiguous encoded repository path: %s", (remote) => {
    expect(() => assertGitRemoteMatchesProfile(remote, credential.profile)).toThrow(
      expect.objectContaining({ code: "invalid_request" })
    );
  });
});

describe("Git workspace operations", () => {
  it("commits ordinary files without staging sensitive workspace files", async () => {
    const repo = mkdtempSync(join(tmpdir(), "pc-git-operation-"));
    roots.push(repo);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    writeFileSync(join(repo, "index.ts"), "export const ok = true\n");
    writeFileSync(join(repo, ".netrc"), "machine example password sentinel\n");
    mkdirSync(join(repo, ".ssh"));
    writeFileSync(join(repo, ".ssh", "id_test"), "sentinel-private-key");

    const result = await runGitWorkspaceOperation({
      workspace: repo,
      operation: "commit",
      credential,
      commitMessage: "initial",
    });
    expect(result.head).toMatch(/^[0-9a-f]{40}$/);
    const tree = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(tree).toContain("index.ts");
    expect(tree).not.toContain(".netrc");
    expect(tree).not.toContain(".ssh");

    const status = await runGitWorkspaceOperation({ workspace: repo, operation: "status" });
    expect(status.summary).not.toContain(".netrc");
    expect(status.summary).not.toContain(".ssh");

    const retry = await runGitWorkspaceOperation({
      workspace: repo,
      operation: "commit",
      credential,
      commitMessage: "retry after a failed push",
    });
    expect(retry.head).toBe(result.head);
    expect(retry.summary).toContain("existing HEAD");

    execFileSync("git", ["add", "-f", ".netrc"], { cwd: repo });
    writeFileSync(join(repo, "index.ts"), "export const ok = false\n");
    await expect(
      runGitWorkspaceOperation({
        workspace: repo,
        operation: "commit",
        credential,
        commitMessage: "must reject staged credential path",
      })
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(
      execFileSync("git", ["show", "--format=", "--name-only", "HEAD"], {
        cwd: repo,
        encoding: "utf8",
      })
    ).not.toContain(".netrc");
  });
});
