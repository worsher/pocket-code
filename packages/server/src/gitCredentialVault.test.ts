import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitCredentialVault, type GitCredentialProfile } from "./gitCredentialVault.js";

const roots: string[] = [];
const profile: GitCredentialProfile = {
  id: "github-main",
  provider: "github",
  authKind: "pat",
  origin: "https://github.com",
  username: "octocat",
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("GitCredentialVault", () => {
  it("encrypts at rest, uses private permissions, and rotates atomically", async () => {
    const root = mkdtempSync(join(tmpdir(), "pc-git-vault-"));
    roots.push(root);
    const vault = new GitCredentialVault(root);
    await vault.upsert("user-a", profile, "sentinel-token-one");
    const files = await import("node:fs/promises").then(({ readdir }) =>
      readdir(join(root, "users"), { recursive: true })
    );
    const recordName = files.find((entry) => String(entry).endsWith(".json"));
    expect(recordName).toBeTruthy();
    const recordPath = join(root, "users", String(recordName));
    expect(readFileSync(recordPath, "utf8")).not.toContain("sentinel-token-one");
    expect(statSync(recordPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "master.key")).mode & 0o777).toBe(0o600);

    const first = await vault.read("user-a", profile.id);
    expect(first.secret).toBe("sentinel-token-one");
    await vault.upsert("user-a", profile, "sentinel-token-two");
    const rotated = await vault.read("user-a", profile.id);
    expect(rotated.secret).toBe("sentinel-token-two");
    expect(rotated.createdAt).toBe(first.createdAt);
    expect(rotated.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
  });

  it("isolates users and deletes idempotently", async () => {
    const root = mkdtempSync(join(tmpdir(), "pc-git-vault-users-"));
    roots.push(root);
    const vault = new GitCredentialVault(root);
    await vault.upsert("user-a", profile, "a-token");
    await expect(vault.read("user-b", profile.id)).rejects.toMatchObject({
      code: "credential_not_found",
    });
    await expect(vault.delete("user-a", profile.id)).resolves.toBe(true);
    await expect(vault.delete("user-a", profile.id)).resolves.toBe(false);
  });

  it("rejects non-HTTPS and credential-bearing origins", async () => {
    const root = mkdtempSync(join(tmpdir(), "pc-git-vault-invalid-"));
    roots.push(root);
    const vault = new GitCredentialVault(root);
    await expect(
      vault.upsert("user-a", { ...profile, origin: "http://github.com" }, "token")
    ).rejects.toMatchObject({ code: "invalid_profile" });
    await expect(
      vault.upsert("user-a", { ...profile, origin: "https://user:pass@github.com" }, "token")
    ).rejects.toMatchObject({ code: "invalid_profile" });
    await expect(
      vault.upsert("user-a", { ...profile, pathPrefix: "/team/../evil" }, "token")
    ).rejects.toMatchObject({ code: "invalid_profile" });
  });
});
