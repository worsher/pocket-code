import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  storage: new Map<string, string>(),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (key: string) => mocks.storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      mocks.storage.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      mocks.storage.delete(key);
    }),
  },
}));

vi.mock("expo-crypto", () => ({
  randomUUID: () => "550e8400-e29b-41d4-a716-446655440000",
}));

const {
  dequeueMessage,
  enqueueMessage,
  getQueue,
  getQueueForScope,
  getQuarantinedMessages,
} = await import("./offlineQueue");
const { createWorkspaceScope } = await import("@pocket-code/workspace-core");

const scope = createWorkspaceScope({
  projectId: "018f00d2-8931-7bc0-aad1-1ec83b13f982",
  replicaId: "74f1d64f-bf59-46a9-aa0b-7dcf42b95cab",
  sessionId: "session-1",
  workspaceGeneration: 3,
});

beforeEach(() => {
  mocks.storage.clear();
});

describe("offline queue scope", () => {
  it("persists and removes a fully scoped message", async () => {
    const queued = await enqueueMessage(scope, "hello");
    expect(await getQueue()).toEqual([queued]);
    await dequeueMessage(queued.id);
    expect(await getQueue()).toEqual([]);
  });

  it("returns messages only for an exact four-field scope match", async () => {
    await enqueueMessage(scope, "hello");
    expect(await getQueueForScope(scope)).toHaveLength(1);
    expect(
      await getQueueForScope(
        createWorkspaceScope({ ...scope, workspaceGeneration: scope.workspaceGeneration + 1 }),
      ),
    ).toEqual([]);
    expect(
      await getQueueForScope(createWorkspaceScope({ ...scope, sessionId: "session-2" })),
    ).toEqual([]);
  });

  it("quarantines legacy unscoped messages instead of replaying them", async () => {
    mocks.storage.set(
      "pocket-code:offline-queue",
      JSON.stringify([
        {
          id: "offline-old",
          sessionId: "session-1",
          content: "must not leak",
          timestamp: 1,
          retries: 0,
        },
      ]),
    );

    expect(await getQueue()).toEqual([]);
    expect(await getQuarantinedMessages()).toHaveLength(1);
  });
});
