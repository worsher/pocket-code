import { beforeAll, describe, expect, it } from "vitest";
import {
  ensureWorkspaceProject,
  getWorkspaceProject,
  initDb,
} from "./db.js";

const PROJECT_ID = "018f00d2-8931-7bc0-aad1-1ec83b13f982";

beforeAll(async () => {
  await initDb();
});

function uuidFactory(values: string[]): () => string {
  let cursor = 0;
  return () => values[cursor++];
}

describe("workspace project catalog", () => {
  it("creates stable records scoped by user and project", () => {
    const first = ensureWorkspaceProject(
      "catalog-user-a",
      PROJECT_ID,
      uuidFactory([
        "550e8400-e29b-41d4-a716-446655440000",
        "74f1d64f-bf59-46a9-aa0b-7dcf42b95cab",
      ]),
    );
    const repeated = ensureWorkspaceProject("catalog-user-a", PROJECT_ID, () => {
      throw new Error("existing catalog entry must not allocate another UUID");
    });
    const otherUser = ensureWorkspaceProject(
      "catalog-user-b",
      PROJECT_ID,
      uuidFactory([
        "151d02d2-93b0-4a26-a50e-9f28eeb323b1",
        "8bb713d6-3408-4f21-8df3-730fd2900c93",
      ]),
    );

    expect(repeated).toEqual(first);
    expect(otherUser.storageKey).not.toBe(first.storageKey);
    expect(getWorkspaceProject("catalog-user-a", PROJECT_ID)).toEqual(first);
    expect(getWorkspaceProject("catalog-user-b", PROJECT_ID)).toEqual(otherUser);
  });

  it("rejects non-UUID project keys in the v2 catalog", () => {
    expect(() => ensureWorkspaceProject("catalog-user", "../escape")).toThrow("UUID");
    expect(() => ensureWorkspaceProject("catalog-user", "default")).toThrow("UUID");
  });
});
