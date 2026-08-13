import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  nextGetError: null as Error | null,
  setCalls: [] as string[],
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (key: string) => {
      if (mocks.nextGetError) {
        const error = mocks.nextGetError;
        mocks.nextGetError = null;
        throw error;
      }
      return mocks.storage.get(key) ?? null;
    }),
    setItem: vi.fn(async (key: string, value: string) => {
      mocks.setCalls.push(key);
      mocks.storage.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      mocks.storage.delete(key);
    }),
  },
}));

let uuidCounter = 0;
vi.mock("expo-crypto", () => ({
  randomUUID: () => `550e8400-e29b-41d4-a716-${String(++uuidCounter).padStart(12, "0")}`,
}));

const {
  dequeueMessage,
  enqueueMessage,
  getQueue,
  getQueueForScope,
  getQueueForReplay,
  getQuarantinedMessages,
  getResumeScopeForProject,
  markUncertain,
  rebindProvisionalQueue,
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
  mocks.nextGetError = null;
  mocks.setCalls.splice(0);
  uuidCounter = 0;
});

describe("offline queue scope", () => {
  it("persists and removes a fully scoped message", async () => {
    const queued = await enqueueMessage(scope, "hello", {
      images: [{ uri: "file://one.png", base64: "abc", mimeType: "image/png" }],
      model: "deepseek-v4-flash",
      customPrompt: "Be concise",
    });
    expect(await getQueue()).toEqual([queued]);
    expect(queued).toMatchObject({ model: "deepseek-v4-flash", customPrompt: "Be concise" });
    await dequeueMessage(queued.id);
    expect(await getQueue()).toEqual([]);
  });

  it("returns messages only for an exact four-field scope match", async () => {
    await enqueueMessage(scope, "hello");
    expect(await getQueueForScope(scope)).toHaveLength(1);
    expect(
      await getQueueForScope(
        createWorkspaceScope({ ...scope, workspaceGeneration: scope.workspaceGeneration + 1 })
      )
    ).toEqual([]);
    expect(
      await getQueueForScope(createWorkspaceScope({ ...scope, sessionId: "session-2" }))
    ).toEqual([]);
  });

  it("keeps both messages when two offline sends enqueue concurrently", async () => {
    const [first, second] = await Promise.all([
      enqueueMessage(scope, "first"),
      enqueueMessage(scope, "second"),
    ]);
    expect(await getQueue()).toEqual([first, second]);
  });

  it("does not overwrite durable records when storage temporarily cannot be read", async () => {
    const existing = await enqueueMessage(scope, "existing", { id: "turn-existing" });
    mocks.setCalls.splice(0);
    mocks.nextGetError = new Error("storage unavailable");

    await expect(enqueueMessage(scope, "new", { id: "turn-new" })).rejects.toThrow(
      "storage unavailable"
    );
    expect(mocks.setCalls).toEqual([]);
    expect(await getQueue()).toEqual([existing]);
  });

  it("recovers the oldest route-bound provisional session after an App restart", async () => {
    await enqueueMessage(scope, "waiting", {
      id: "turn-waiting",
      provisional: true,
      connectionKey: "relay:wss://relay.example:machine-a",
    });
    expect(
      await getResumeScopeForProject({
        projectId: scope.projectId,
        connectionKey: "relay:wss://relay.example:machine-a",
      })
    ).toEqual(scope);
    expect(
      await getResumeScopeForProject({
        projectId: scope.projectId,
        connectionKey: "relay:wss://relay.example:machine-b",
      })
    ).toBeNull();
  });

  it("recovers an authoritative queued turn only for its retained remote replica", async () => {
    await enqueueMessage(scope, "waiting", {
      id: "turn-authoritative",
      connectionKey: "cloud:wss://cloud.example",
      authorityId: "authority-a",
    });

    expect(
      await getResumeScopeForProject({
        projectId: scope.projectId,
        connectionKey: "cloud:wss://cloud.example",
        retainedReplica: {
          id: scope.replicaId,
          generation: scope.workspaceGeneration,
          authorityId: "authority-a",
        },
      })
    ).toEqual(scope);
    expect(
      await getResumeScopeForProject({
        projectId: scope.projectId,
        connectionKey: "cloud:wss://cloud.example",
        retainedReplica: {
          id: scope.replicaId,
          generation: scope.workspaceGeneration + 1,
          authorityId: "authority-a",
        },
      })
    ).toBeNull();
  });

  it("upserts a live submission by its stable turn id", async () => {
    const first = await enqueueMessage(scope, "first", { id: "turn-stable" });
    const updated = await enqueueMessage(scope, "updated", {
      id: "turn-stable",
      model: "gpt-4o-mini",
    });
    expect(first.id).toBe("turn-stable");
    expect(await getQueue()).toEqual([updated]);
  });

  it("keeps FIFO position across stable-id upsert and dequeues only that turn", async () => {
    await enqueueMessage(scope, "first", { id: "turn-1" });
    const second = await enqueueMessage(scope, "second", { id: "turn-2" });
    const updatedFirst = await enqueueMessage(scope, "first updated", {
      id: "turn-1",
      model: "gpt-4o-mini",
    });

    expect((await getQueue()).map((message) => message.id)).toEqual(["turn-1", "turn-2"]);
    expect(await getQueue()).toEqual([updatedFirst, second]);

    await dequeueMessage("turn-1");
    expect(await getQueue()).toEqual([second]);
  });

  it("serializes enqueue/dequeue mutations without resurrecting an acknowledged turn", async () => {
    await enqueueMessage(scope, "first", { id: "turn-1" });

    const enqueueSecond = enqueueMessage(scope, "second", { id: "turn-2" });
    const dequeueFirst = dequeueMessage("turn-1");
    const [second] = await Promise.all([enqueueSecond, dequeueFirst]);

    expect(await getQueue()).toEqual([second]);
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
      ])
    );

    expect(await getQueue()).toEqual([]);
    expect(await getQuarantinedMessages()).toHaveLength(1);
  });

  it("rebinds only explicitly provisional messages after remote acknowledgement", async () => {
    const provisional = await enqueueMessage(scope, "waiting", {
      provisional: true,
      connectionKey: "cloud:wss://cloud.example",
    });
    const fixed = await enqueueMessage(scope, "already bound");
    const remoteScope = createWorkspaceScope({
      ...scope,
      replicaId: "151d02d2-93b0-4a26-a50e-9f28eeb323b1",
      workspaceGeneration: 1,
    });

    expect(
      await rebindProvisionalQueue(scope, remoteScope, {
        connectionKey: "cloud:wss://cloud.example",
        authorityId: "authority-a",
      })
    ).toBe(1);
    expect(await getQueueForScope(remoteScope)).toEqual([
      {
        ...provisional,
        scope: remoteScope,
        authorityId: "authority-a",
        provisional: false,
      },
    ]);
    expect(await getQueueForScope(scope)).toEqual([fixed]);
  });

  it("does not rebind another route or a legacy provisional turn sharing the same scope", async () => {
    const routeA = await enqueueMessage(scope, "route A", {
      id: "turn-route-a",
      provisional: true,
      connectionKey: "relay:wss://relay.example:machine-a",
    });
    const routeB = await enqueueMessage(scope, "route B", {
      id: "turn-route-b",
      provisional: true,
      connectionKey: "relay:wss://relay.example:machine-b",
    });
    const legacy = await enqueueMessage(scope, "legacy", {
      id: "turn-legacy",
      provisional: true,
    });
    const authoritativeScope = createWorkspaceScope({
      ...scope,
      replicaId: "151d02d2-93b0-4a26-a50e-9f28eeb323b1",
      workspaceGeneration: 1,
    });

    expect(
      await rebindProvisionalQueue(scope, authoritativeScope, {
        connectionKey: "relay:wss://relay.example:machine-a",
        authorityId: "authority-a",
      })
    ).toBe(1);
    expect(await getQueueForScope(authoritativeScope)).toEqual([
      {
        ...routeA,
        scope: authoritativeScope,
        authorityId: "authority-a",
        provisional: false,
      },
    ]);
    expect(await getQueueForScope(scope)).toEqual([routeB, legacy]);
  });

  it("drains only an exact authoritative route and never legacy or provisional records", async () => {
    const expected = await enqueueMessage(scope, "expected", {
      id: "turn-expected",
      connectionKey: "cloud:wss://cloud.example",
      authorityId: "authority-a",
    });
    await enqueueMessage(scope, "wrong authority", {
      id: "turn-wrong-authority",
      connectionKey: "cloud:wss://cloud.example",
      authorityId: "authority-b",
    });
    await enqueueMessage(scope, "wrong route", {
      id: "turn-wrong-route",
      connectionKey: "cloud:wss://other.example",
      authorityId: "authority-a",
    });
    await enqueueMessage(scope, "still provisional", {
      id: "turn-provisional",
      provisional: true,
      connectionKey: "cloud:wss://cloud.example",
      authorityId: "authority-a",
    });
    await enqueueMessage(scope, "legacy authoritative", {
      id: "turn-legacy-authoritative",
    });

    expect(
      await getQueueForReplay(scope, {
        connectionKey: "cloud:wss://cloud.example",
        authorityId: "authority-a",
      })
    ).toEqual([expected]);
  });

  it("keeps an uncertain turn durable but excludes it from resume and automatic replay", async () => {
    await enqueueMessage(scope, "possibly executed", {
      id: "turn-uncertain",
      connectionKey: "cloud:wss://cloud.example",
      authorityId: "authority-a",
    });
    await markUncertain("turn-uncertain", "legacy-disconnect");
    await enqueueMessage(scope, "must not overtake", {
      id: "turn-after-uncertain",
      connectionKey: "cloud:wss://cloud.example",
      authorityId: "authority-a",
    });

    expect(await getQueue()).toMatchObject([
      { id: "turn-uncertain", retries: 1, blockedReason: "legacy-disconnect" },
      { id: "turn-after-uncertain" },
    ]);
    expect(
      await getQueueForReplay(scope, {
        connectionKey: "cloud:wss://cloud.example",
        authorityId: "authority-a",
      })
    ).toEqual([]);
    expect(
      await getResumeScopeForProject({
        projectId: scope.projectId,
        connectionKey: "cloud:wss://cloud.example",
        retainedReplica: {
          id: scope.replicaId,
          generation: scope.workspaceGeneration,
          authorityId: "authority-a",
        },
      })
    ).toBeNull();
  });
});
