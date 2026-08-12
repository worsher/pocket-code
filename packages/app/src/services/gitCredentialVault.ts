import * as SecureStore from "expo-secure-store";
import type { GitCredentialProfile } from "./gitCredentialProfiles";
import { secretRefForGitCredentialProfile } from "./gitCredentialProfiles";

export interface GitCredentialSecretStorage {
  isAvailable(): Promise<boolean>;
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}

const secureStoreAdapter: GitCredentialSecretStorage = {
  isAvailable: () => SecureStore.isAvailableAsync(),
  getItem: (key) => SecureStore.getItemAsync(key),
  setItem: (key, value) =>
    SecureStore.setItemAsync(key, value, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }),
  deleteItem: (key) => SecureStore.deleteItemAsync(key),
};

export interface GitCredentialVault {
  get(profileId: string): Promise<string | null>;
  set(profileId: string, secret: string): Promise<void>;
  delete(profileId: string): Promise<void>;
  has(profileId: string): Promise<boolean>;
}

export function createGitCredentialVault(
  storage: GitCredentialSecretStorage = secureStoreAdapter
): GitCredentialVault {
  const ensureAvailable = async () => {
    if (!(await storage.isAvailable())) {
      throw new Error("Secure credential storage is unavailable on this device");
    }
  };

  return {
    async get(profileId) {
      await ensureAvailable();
      return storage.getItem(secretRefForGitCredentialProfile(profileId));
    },
    async set(profileId, secret) {
      await ensureAvailable();
      const value = secret.trim();
      if (!value) throw new Error("Git API Key / PAT must not be empty");
      const key = secretRefForGitCredentialProfile(profileId);
      await storage.setItem(key, value);
      const verified = await storage.getItem(key);
      if (verified !== value) {
        throw new Error("Git credential could not be verified after secure storage write");
      }
    },
    async delete(profileId) {
      await ensureAvailable();
      await storage.deleteItem(secretRefForGitCredentialProfile(profileId));
    },
    async has(profileId) {
      await ensureAvailable();
      return !!(await storage.getItem(secretRefForGitCredentialProfile(profileId)));
    },
  };
}

export const gitCredentialVault = createGitCredentialVault();

export async function persistGitCredentialProfileChanges(args: {
  profiles: readonly GitCredentialProfile[];
  secretDrafts: Readonly<Record<string, string>>;
  clearedProfileIds: readonly string[];
  persistMetadata(profiles: GitCredentialProfile[]): Promise<void>;
  vault?: GitCredentialVault;
}): Promise<GitCredentialProfile[]> {
  const vault = args.vault ?? gitCredentialVault;
  const drafts = new Map(
    Object.entries(args.secretDrafts)
      .map(([id, secret]) => [id, secret.trim()] as const)
      .filter(([, secret]) => !!secret)
  );
  const cleared = new Set(args.clearedProfileIds);
  const touched = new Set([...drafts.keys(), ...cleared]);
  const previous = new Map<string, string | null>();

  try {
    for (const id of touched) previous.set(id, await vault.get(id));
    for (const [id, secret] of drafts) await vault.set(id, secret);
    for (const id of cleared) {
      if (!drafts.has(id)) await vault.delete(id);
    }

    const now = Date.now();
    const profiles = args.profiles.map((profile) => ({
      ...profile,
      hasSecret: drafts.has(profile.id)
        ? true
        : cleared.has(profile.id)
          ? false
          : profile.hasSecret,
      ...(touched.has(profile.id) ? { updatedAt: now } : {}),
    }));
    await args.persistMetadata(profiles);
    return profiles;
  } catch (error) {
    // Restore the last committed secret state when metadata persistence or a later write fails.
    for (const [id, secret] of previous) {
      try {
        if (secret) await vault.set(id, secret);
        else await vault.delete(id);
      } catch {
        // The original error remains primary; a later retry reconciles metadata and vault state.
      }
    }
    throw error;
  }
}

export async function readGitCredentialSecret(
  profile: Pick<GitCredentialProfile, "id" | "hasSecret">
): Promise<string> {
  if (!profile.hasSecret) throw new Error("The selected Git credential has no saved Key");
  const secret = await gitCredentialVault.get(profile.id);
  if (!secret) throw new Error("The selected Git credential is missing from secure storage");
  return secret;
}
