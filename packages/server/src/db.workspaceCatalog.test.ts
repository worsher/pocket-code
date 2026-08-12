import { beforeAll, describe, expect, it } from "vitest";
import {
  ensureWorkspaceProject,
  getWorkspaceProject,
  getWorkspaceAuthorityId,
  listWorkspaceProjects,
  updateWorkspaceProjectDisplayName,
  releaseWorkspaceProjectWriter,
  isWorkspaceSessionGenerationCurrent,
  commitGitWorkspaceImport,
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
      uuidFactory(["550e8400-e29b-41d4-a716-446655440000", "74f1d64f-bf59-46a9-aa0b-7dcf42b95cab"])
    );
    const repeated = ensureWorkspaceProject("catalog-user-a", PROJECT_ID, () => {
      throw new Error("existing catalog entry must not allocate another UUID");
    });
    const otherUser = ensureWorkspaceProject(
      "catalog-user-b",
      PROJECT_ID,
      uuidFactory(["151d02d2-93b0-4a26-a50e-9f28eeb323b1", "8bb713d6-3408-4f21-8df3-730fd2900c93"])
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

  it("persists one stable authority id for the catalog", () => {
    const expected = "3ca2e8bb-4fe5-4e16-a6ca-99840d666870";
    const first = getWorkspaceAuthorityId(() => expected);
    const repeated = getWorkspaceAuthorityId(() => {
      throw new Error("an existing authority must not allocate another UUID");
    });
    expect(first).toBe(expected);
    expect(repeated).toBe(expected);
  });

  it("lists only the user's projects and retains display metadata", () => {
    updateWorkspaceProjectDisplayName("catalog-user-a", PROJECT_ID, "Phone project");
    expect(listWorkspaceProjects("catalog-user-a")).toEqual([
      expect.objectContaining({
        userId: "catalog-user-a",
        projectId: PROJECT_ID,
        displayName: "Phone project",
      }),
    ]);
    expect(listWorkspaceProjects("catalog-user-b")[0].displayName).toBe("");
  });

  it("releases a writer with compare-and-swap generation semantics", () => {
    const record = ensureWorkspaceProject(
      "catalog-user-release",
      PROJECT_ID,
      uuidFactory(["0f3d985e-0a3a-458e-932d-c89dbbf671c6", "ce393574-d077-4ddf-a34a-bd9746277f97"])
    );
    expect(
      isWorkspaceSessionGenerationCurrent({
        userId: record.userId,
        projectId: record.projectId,
        replicaId: record.replicaId,
        generation: record.generation,
      })
    ).toBe(true);
    const released = releaseWorkspaceProjectWriter({
      userId: record.userId,
      projectId: record.projectId,
      replicaId: record.replicaId,
      expectedGeneration: record.generation,
    });
    expect(released.generation).toBe(record.generation + 1);
    expect(
      isWorkspaceSessionGenerationCurrent({
        userId: record.userId,
        projectId: record.projectId,
        replicaId: record.replicaId,
        generation: record.generation,
      })
    ).toBe(false);
    expect(() =>
      releaseWorkspaceProjectWriter({
        userId: record.userId,
        projectId: record.projectId,
        replicaId: record.replicaId,
        expectedGeneration: record.generation,
      })
    ).toThrow("generation is stale");
  });

  it("commits Git import metadata once and preserves its source identity", () => {
    const userId = `catalog-git-user-${Date.now()}`;
    const projectId = "8ec534af-ef2a-4e57-9212-d4db31e638df";
    ensureWorkspaceProject(userId, projectId);
    const source = {
      mode: "git" as const,
      sourceKind: "git" as const,
      sourceDeviceId: "authority-id",
      canonicalLocator: "https://git.example.com/team/project.git",
      identity: {
        importMode: "git" as const,
        sourceKind: "git" as const,
        weakKeys: ['["git","git.example.com/team/project"]'],
      },
      importedSnapshot: "0123456789012345678901234567890123456789",
      importedAt: Date.now(),
      writeBackPolicy: "git" as const,
    };
    expect(
      commitGitWorkspaceImport({ userId, projectId, displayName: "Git project", importSource: source })
    ).toMatchObject({ displayName: "Git project", importSource: source });
    expect(() =>
      commitGitWorkspaceImport({ userId, projectId, displayName: "Again", importSource: source })
    ).toThrow("already bound or imported");
  });
});
