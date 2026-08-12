import { describe, expect, it, vi } from "vitest";

vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "WHEN_UNLOCKED_THIS_DEVICE_ONLY",
  isAvailableAsync: async () => true,
  getItemAsync: async () => null,
  setItemAsync: async () => undefined,
  deleteItemAsync: async () => undefined,
}));

import {
  createGitCredentialVault,
  persistGitCredentialProfileChanges,
  type GitCredentialSecretStorage,
} from "./gitCredentialVault";
import type { GitCredentialProfile } from "./gitCredentialProfiles";

function memoryStorage(values = new Map<string, string>()): GitCredentialSecretStorage {
  return {
    isAvailable: async () => true,
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      values.set(key, value);
    },
    deleteItem: async (key) => {
      values.delete(key);
    },
  };
}

const profile: GitCredentialProfile = {
  id: "github-pat",
  label: "GitHub API Key / PAT",
  provider: "github",
  authKind: "pat",
  origin: "https://github.com",
  username: "oauth2",
  secretRef: "git-credential.github-pat",
  hasSecret: false,
};

describe("Git credential SecureStore vault", () => {
  it("writes and verifies a secret without exposing it in profile metadata", async () => {
    const values = new Map<string, string>();
    const vault = createGitCredentialVault(memoryStorage(values));
    await vault.set(profile.id, "github-secret");
    expect(await vault.get(profile.id)).toBe("github-secret");
    expect(JSON.stringify(profile)).not.toContain("github-secret");
  });

  it("rolls the vault back when metadata persistence fails", async () => {
    const values = new Map<string, string>([[profile.secretRef, "old-secret"]]);
    const vault = createGitCredentialVault(memoryStorage(values));
    await expect(
      persistGitCredentialProfileChanges({
        profiles: [{ ...profile, hasSecret: true }],
        secretDrafts: { [profile.id]: "new-secret" },
        clearedProfileIds: [],
        persistMetadata: async () => {
          throw new Error("settings write failed");
        },
        vault,
      })
    ).rejects.toThrow("settings write failed");
    expect(await vault.get(profile.id)).toBe("old-secret");
  });
});
