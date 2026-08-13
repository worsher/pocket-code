import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = new Map<string, string>();
const pendingChatWrites: Array<() => void> = [];
const operations: string[] = [];
let nextChatWriteError: Error | null = null;
let nextChatReadError: Error | null = null;
let nextIndexReadError: Error | null = null;

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (key: string) => {
      if (key === "pocket-code:sessions" && nextIndexReadError) {
        const error = nextIndexReadError;
        nextIndexReadError = null;
        throw error;
      }
      if (key.startsWith("pocket-code:chat:") && nextChatReadError) {
        const error = nextChatReadError;
        nextChatReadError = null;
        throw error;
      }
      return storage.get(key) ?? null;
    }),
    setItem: vi.fn((key: string, value: string) => {
      if (key.startsWith("pocket-code:chat:")) {
        if (nextChatWriteError) {
          const error = nextChatWriteError;
          nextChatWriteError = null;
          operations.push(`reject:${key}`);
          return Promise.reject(error);
        }
        return new Promise<void>((resolve) => {
          pendingChatWrites.push(() => {
            operations.push(`set:${key}`);
            storage.set(key, value);
            resolve();
          });
        });
      }
      operations.push(`set:${key}`);
      storage.set(key, value);
      return Promise.resolve();
    }),
    removeItem: vi.fn(async (key: string) => {
      operations.push(`remove:${key}`);
      storage.delete(key);
    }),
    multiRemove: vi.fn(async (keys: string[]) => {
      operations.push(`multiRemove:${keys.join(",")}`);
      keys.forEach((key) => storage.delete(key));
    }),
  },
}));

const {
  deleteSession,
  listSessions,
  loadChatHistory,
  loadChatHistoryStrict,
  reassignSessionsProjectId,
  saveChatHistory,
} = await import("./chatHistory");

beforeEach(() => {
  storage.clear();
  pendingChatWrites.splice(0);
  operations.splice(0);
  nextChatWriteError = null;
  nextChatReadError = null;
  nextIndexReadError = null;
});

describe("chat history write ordering", () => {
  it("serializes saves so a late older write cannot overwrite the latest turn", async () => {
    const first = [{ id: "u1", role: "user" as const, content: "one", timestamp: 1 }];
    const second = [
      ...first,
      { id: "a1", role: "assistant" as const, content: "answer", timestamp: 2 },
    ];

    const saveFirst = saveChatHistory("s1", first, "p1");
    const saveSecond = saveChatHistory("s1", second, "p1");
    await vi.waitFor(() => expect(pendingChatWrites).toHaveLength(1));
    pendingChatWrites.shift()!();
    await saveFirst;
    await vi.waitFor(() => expect(pendingChatWrites).toHaveLength(1));
    pendingChatWrites.shift()!();
    await saveSecond;

    expect(await loadChatHistory("s1")).toEqual(second);
  });

  it("surfaces a failed save to its caller and lets the next queued save proceed", async () => {
    nextChatWriteError = new Error("disk full");
    const failed = [{ id: "u1", role: "user" as const, content: "lost", timestamp: 1 }];

    await expect(saveChatHistory("s1", failed, "p1")).rejects.toThrow("disk full");
    expect(await loadChatHistory("s1")).toEqual([]);

    const recovered = [{ id: "u2", role: "user" as const, content: "saved", timestamp: 2 }];
    const saveRecovered = saveChatHistory("s1", recovered, "p1");
    await vi.waitFor(() => expect(pendingChatWrites).toHaveLength(1));
    pendingChatWrites.shift()!();
    await saveRecovered;

    expect(await loadChatHistory("s1")).toEqual(recovered);
  });

  it("lets recovery distinguish an unreadable archive from an empty session", async () => {
    nextChatReadError = new Error("storage unavailable");
    await expect(loadChatHistoryStrict("s1")).rejects.toThrow("storage unavailable");
  });

  it("serializes delete behind an in-flight save so the session cannot be resurrected", async () => {
    const messages = [{ id: "u1", role: "user" as const, content: "one", timestamp: 1 }];
    const save = saveChatHistory("s1", messages, "p1");
    const remove = deleteSession("s1");

    await vi.waitFor(() => expect(pendingChatWrites).toHaveLength(1));
    expect(operations).not.toContain("remove:pocket-code:chat:s1");
    pendingChatWrites.shift()!();
    await Promise.all([save, remove]);

    expect(storage.has("pocket-code:chat:s1")).toBe(false);
    expect(await listSessions()).toEqual([]);
  });

  it("serializes project reassignment behind save/index creation", async () => {
    const messages = [{ id: "u1", role: "user" as const, content: "one", timestamp: 1 }];
    const save = saveChatHistory("s1", messages, "legacy-project");
    const reassign = reassignSessionsProjectId("legacy-project", "project-v2");

    await vi.waitFor(() => expect(pendingChatWrites).toHaveLength(1));
    pendingChatWrites.shift()!();
    await expect(Promise.all([save, reassign])).resolves.toEqual([undefined, 1]);

    expect(await listSessions()).toMatchObject([{ id: "s1", projectId: "project-v2" }]);
  });

  it("does not overwrite the session index or chat when save cannot read the index", async () => {
    const originalIndex = JSON.stringify([
      { id: "s1", projectId: "p1", title: "old", lastUpdated: 1, messageCount: 1 },
    ]);
    const originalChat = JSON.stringify([{ id: "u1", role: "user", content: "old", timestamp: 1 }]);
    storage.set("pocket-code:sessions", originalIndex);
    storage.set("pocket-code:chat:s1", originalChat);
    nextIndexReadError = new Error("index unavailable");

    await expect(
      saveChatHistory(
        "s1",
        [{ id: "u2", role: "user", content: "replacement", timestamp: 2 }],
        "p1"
      )
    ).rejects.toThrow("index unavailable");

    expect(storage.get("pocket-code:sessions")).toBe(originalIndex);
    expect(storage.get("pocket-code:chat:s1")).toBe(originalChat);
    expect(operations).toEqual([]);
  });

  it("does not remove chat or overwrite the session index when delete cannot read the index", async () => {
    const originalIndex = JSON.stringify([
      { id: "s1", projectId: "p1", title: "old", lastUpdated: 1, messageCount: 1 },
    ]);
    storage.set("pocket-code:sessions", originalIndex);
    storage.set("pocket-code:chat:s1", "stored chat");
    nextIndexReadError = new Error("index unavailable");

    await expect(deleteSession("s1")).rejects.toThrow("index unavailable");

    expect(storage.get("pocket-code:sessions")).toBe(originalIndex);
    expect(storage.get("pocket-code:chat:s1")).toBe("stored chat");
    expect(operations).toEqual([]);
  });

  it("does not overwrite the session index when reassignment cannot read it", async () => {
    const originalIndex = JSON.stringify([
      {
        id: "s1",
        projectId: "legacy-project",
        title: "old",
        lastUpdated: 1,
        messageCount: 1,
      },
    ]);
    storage.set("pocket-code:sessions", originalIndex);
    nextIndexReadError = new Error("index unavailable");

    await expect(reassignSessionsProjectId("legacy-project", "project-v2")).rejects.toThrow(
      "index unavailable"
    );

    expect(storage.get("pocket-code:sessions")).toBe(originalIndex);
    expect(operations).toEqual([]);
  });

  it("keeps read-only listing backward-compatible for an invalid index", async () => {
    storage.set("pocket-code:sessions", "not-json");

    await expect(listSessions()).resolves.toEqual([]);
    await expect(reassignSessionsProjectId("legacy", "v2")).rejects.toThrow();
    expect(storage.get("pocket-code:sessions")).toBe("not-json");
    expect(operations).toEqual([]);
  });
});
