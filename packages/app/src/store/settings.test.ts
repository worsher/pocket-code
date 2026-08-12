import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  asyncStorage: new Map<string, string>(),
  secureStorage: new Map<string, string>(),
  secureStoreFails: false,
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (key: string) => mocks.asyncStorage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      mocks.asyncStorage.set(key, value);
    }),
  },
}));

vi.mock("../utils/runtimePlatform", () => ({ runtimePlatformOS: "android" }));

vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "WHEN_UNLOCKED_THIS_DEVICE_ONLY",
  isAvailableAsync: vi.fn(async () => !mocks.secureStoreFails),
  getItemAsync: vi.fn(async (key: string) => {
    if (mocks.secureStoreFails) throw new Error("keychain unavailable");
    return mocks.secureStorage.get(key) ?? null;
  }),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    if (mocks.secureStoreFails) throw new Error("keychain unavailable");
    mocks.secureStorage.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    mocks.secureStorage.delete(key);
  }),
}));

const { loadSettings, saveSettings } = await import("./settings");

const SETTINGS_KEY = "pocket-code:settings";

beforeEach(() => {
  mocks.asyncStorage.clear();
  mocks.secureStorage.clear();
  mocks.secureStoreFails = false;
});

describe("Git credential settings migration", () => {
  it("moves a legacy plaintext token to SecureStore before removing it", async () => {
    mocks.asyncStorage.set(
      SETTINGS_KEY,
      JSON.stringify({
        mode: "geek",
        gitCredentials: [
          { platform: "github", host: "github.com", username: "oauth2", token: "legacy-token" },
        ],
      })
    );

    const loaded = await loadSettings();
    const persisted = mocks.asyncStorage.get(SETTINGS_KEY)!;

    expect(loaded.gitCredentialProfiles.find((entry) => entry.id === "github-pat")?.hasSecret).toBe(
      true
    );
    expect(mocks.secureStorage.get("git-credential.github-pat")).toBe("legacy-token");
    expect(persisted).not.toContain("legacy-token");
    expect(JSON.parse(persisted).gitCredentials).toBeUndefined();
  });

  it("keeps the old record intact and retries after SecureStore recovers", async () => {
    const legacy = JSON.stringify({
      gitCredentials: [
        { platform: "gitlab", host: "gitlab.company.test:8443/gitlab", token: "retry-token" },
      ],
    });
    mocks.asyncStorage.set(SETTINGS_KEY, legacy);
    mocks.secureStoreFails = true;

    const pending = await loadSettings();
    expect(pending.gitCredentialMigrationPending).toBe(true);
    expect(mocks.asyncStorage.get(SETTINGS_KEY)).toBe(legacy);

    mocks.secureStoreFails = false;
    const migrated = await loadSettings();
    expect(migrated.gitCredentialMigrationPending).toBeUndefined();
    expect(mocks.asyncStorage.get(SETTINGS_KEY)).not.toContain("retry-token");
    expect([...mocks.secureStorage.values()]).toContain("retry-token");
  });

  it("never persists a migration flag or secret-shaped legacy property", async () => {
    const settings = await loadSettings();
    await saveSettings({ ...settings, gitCredentialMigrationPending: true });
    const persisted = JSON.parse(mocks.asyncStorage.get(SETTINGS_KEY)!);
    expect(persisted.gitCredentialMigrationPending).toBeUndefined();
    expect(persisted.gitCredentials).toBeUndefined();
  });
});
