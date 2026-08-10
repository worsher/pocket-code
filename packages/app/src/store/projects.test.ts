import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  writes: [] as Array<{ key: string; value: string }>,
  failNextPrimaryWrite: false,
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (key: string) => mocks.storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      await Promise.resolve();
      if (key === "pocket-code:projects" && mocks.failNextPrimaryWrite) {
        mocks.failNextPrimaryWrite = false;
        throw new Error("storage full");
      }
      mocks.writes.push({ key, value });
      mocks.storage.set(key, value);
    }),
  },
}));

vi.mock("expo-crypto", () => ({
  randomUUID: () => "550e8400-e29b-41d4-a716-446655440000",
}));

const { loadProjects, saveCurrentProjectId, saveProjects } = await import("./projects");

const project = (id: string, name: string) => ({
  catalogVersion: 2 as const,
  id,
  name,
  description: "",
  localReplica: {
    id: "74f1d64f-bf59-46a9-aa0b-7dcf42b95cab",
    storageKey: "ws_018f00d289317bc0aad11ec83b13f982",
    generation: 1,
    layout: "v2" as const,
  },
  createdAt: 1,
  updatedAt: 1,
});

beforeEach(() => {
  mocks.storage.clear();
  mocks.writes.length = 0;
  mocks.failNextPrimaryWrite = false;
});

describe("project catalog persistence", () => {
  it("serializes overlapping catalog and current-project writes", async () => {
    const first = [project("018f00d2-8931-7bc0-aad1-1ec83b13f982", "First")];
    const second = [project("018f00d2-8931-7bc0-aad1-1ec83b13f982", "Second")];

    await Promise.all([saveProjects(first), saveProjects(second)]);
    await Promise.all([saveCurrentProjectId("first"), saveCurrentProjectId("second")]);

    expect(JSON.parse(mocks.storage.get("pocket-code:projects")!)[0].name).toBe("Second");
    expect(mocks.storage.get("pocket-code:current-project")).toBe("second");
    expect(JSON.parse(mocks.storage.get("pocket-code:projects:backup")!)[0].name).toBe("First");
  });

  it("recovers a corrupt primary catalog from the last valid backup", async () => {
    const backup = [project("018f00d2-8931-7bc0-aad1-1ec83b13f982", "Recovered")];
    mocks.storage.set("pocket-code:projects", "{broken-json");
    mocks.storage.set("pocket-code:projects:backup", JSON.stringify(backup));

    const loaded = await loadProjects();

    expect(loaded[0]?.name).toBe("Recovered");
    expect(JSON.parse(mocks.storage.get("pocket-code:projects")!)[0].name).toBe("Recovered");
    expect(JSON.parse(mocks.storage.get("pocket-code:projects:corrupt")!).raw).toBe("{broken-json");
  });

  it("keeps the backup when replacing a corrupt primary", async () => {
    mocks.storage.set("pocket-code:projects", "not-json");
    mocks.storage.set("pocket-code:projects:backup", JSON.stringify([{ name: "Last good" }]));

    await saveProjects([project("018f00d2-8931-7bc0-aad1-1ec83b13f982", "New")]);

    expect(JSON.parse(mocks.storage.get("pocket-code:projects:backup")!)[0].name).toBe("Last good");
  });

  it("continues serial writes after one persistence failure", async () => {
    mocks.failNextPrimaryWrite = true;
    await expect(
      saveProjects([project("018f00d2-8931-7bc0-aad1-1ec83b13f982", "Failed")])
    ).rejects.toThrow("storage full");

    await saveProjects([project("018f00d2-8931-7bc0-aad1-1ec83b13f982", "Retried")]);

    expect(JSON.parse(mocks.storage.get("pocket-code:projects")!)[0].name).toBe("Retried");
  });
});
