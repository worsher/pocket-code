import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitCredentialVault } from "./gitCredentialVault.js";
import {
  cleanupLegacyWorkspaceCredentials,
  migrateLegacyGitCredentials,
} from "./gitCredentials.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("legacy Git credential migration", () => {
  it("removes only Pocket Code root artifacts", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "pc-legacy-git-"));
    roots.push(workspace);
    writeFileSync(join(workspace, ".git-credentials"), "https://oauth2:secret@example.com\n");
    writeFileSync(join(workspace, ".gitconfig"), "[credential]\n\thelper = store\n");
    writeFileSync(join(workspace, ".netrc"), "user-owned");
    await expect(cleanupLegacyWorkspaceCredentials(workspace)).resolves.toBe(2);
    expect(existsSync(join(workspace, ".git-credentials"))).toBe(false);
    expect(existsSync(join(workspace, ".gitconfig"))).toBe(false);
    expect(existsSync(join(workspace, ".netrc"))).toBe(true);
  });

  it("does not delete user-owned root files with different contents", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "pc-user-git-config-"));
    roots.push(workspace);
    writeFileSync(join(workspace, ".git-credentials"), "documentation, not a credential store\n");
    writeFileSync(join(workspace, ".gitconfig"), "[user]\n\tname = Example\n");
    await expect(cleanupLegacyWorkspaceCredentials(workspace)).resolves.toBe(0);
    expect(existsSync(join(workspace, ".git-credentials"))).toBe(true);
    expect(existsSync(join(workspace, ".gitconfig"))).toBe(true);
  });

  it("never deletes a matching file tracked by the user's repository", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "pc-tracked-git-config-"));
    roots.push(workspace);
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    writeFileSync(join(workspace, ".gitconfig"), "[credential]\n\thelper = store\n");
    execFileSync("git", ["add", "-f", ".gitconfig"], { cwd: workspace });
    await expect(cleanupLegacyWorkspaceCredentials(workspace)).resolves.toBe(0);
    expect(existsSync(join(workspace, ".gitconfig"))).toBe(true);
  });

  it("moves legacy init secrets to the encrypted vault", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "pc-legacy-git-migrate-"));
    const vaultRoot = mkdtempSync(join(tmpdir(), "pc-legacy-vault-"));
    roots.push(workspace, vaultRoot);
    const vault = new GitCredentialVault(vaultRoot);
    const [profileId] = await migrateLegacyGitCredentials({
      workspace,
      userId: "legacy-user",
      vault,
      credentials: [
        {
          platform: "github",
          host: "github.com",
          username: "octocat",
          token: "legacy-sentinel",
        },
      ],
    });
    expect(profileId).toMatch(/^legacy-/);
    await expect(vault.read("legacy-user", profileId)).resolves.toMatchObject({
      secret: "legacy-sentinel",
      profile: { provider: "github", origin: "https://github.com" },
    });
  });
});
