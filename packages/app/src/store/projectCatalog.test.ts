import { describe, expect, it } from "vitest";
import {
  createProject,
  createProjectFromRemote,
  createImportedProject,
  resolveStoredCurrentProjectId,
  upgradeProjectCatalog,
  upsertRemoteReplica,
  upsertProjectSyncEdge,
  getProjectSyncEdge,
  handoffProjectWriterLease,
  promoteLegacyProjectToV2,
  type ProjectIdFactories,
} from "./projectCatalog";

function factories(): ProjectIdFactories {
  const values = [
    "018f00d2-8931-7bc0-aad1-1ec83b13f982",
    "550e8400-e29b-41d4-a716-446655440000",
    "74f1d64f-bf59-46a9-aa0b-7dcf42b95cab",
  ];
  let cursor = 0;
  const next = () => values[cursor++ % values.length];
  return { projectUuid: next, replicaUuid: next, storageUuid: next };
}

describe("mobile project catalog v2", () => {
  it("creates new projects with independent UUID identity and storage key", () => {
    const project = createProject("Phone project", factories(), "", undefined, 100);
    expect(project.id).toBe("018f00d2-8931-7bc0-aad1-1ec83b13f982");
    expect(project.localReplica).toEqual({
      id: "550e8400-e29b-41d4-a716-446655440000",
      storageKey: "ws_74f1d64fbf5946a9aa0b7dcf42b95cab",
      generation: 1,
      layout: "v2",
    });
    expect(project.localReplica.storageKey).not.toContain(project.id);
  });

  it("persists only the Git credential profile ID with a project", () => {
    const created = {
      ...createProject("Private repo", factories(), "", "https://github.com/acme/private.git", 100),
      gitCredentialProfileId: "github-pat",
    };
    const upgraded = upgradeProjectCatalog([created], factories(), 200);
    expect(upgraded.projects[0].gitCredentialProfileId).toBe("github-pat");
    expect(JSON.stringify(upgraded.projects[0])).not.toContain("token");
  });

  it("adopts a remote-created project with a new independent mobile replica", () => {
    const project = createProjectFromRemote(
      "10ed836e-ae48-4d67-9e26-a74cbf55a52e",
      "Cloud project",
      factories(),
      100
    );
    expect(project).toMatchObject({
      id: "10ed836e-ae48-4d67-9e26-a74cbf55a52e",
      name: "Cloud project",
      localReplica: { layout: "v2", generation: 1 },
    });
    expect(project.localReplica.storageKey).not.toContain(project.id);
  });

  it("keeps the implicit default workspace discoverable during migration", () => {
    const result = upgradeProjectCatalog(null, factories(), 100, {
      preserveImplicitLegacyDefault: true,
    });
    expect(result.changed).toBe(true);
    expect(result.projects[0]).toMatchObject({
      id: "default",
      legacyId: "default",
      localReplica: { layout: "legacy-default" },
    });
  });

  it("creates a normal v2 project for a fresh installation", () => {
    const result = upgradeProjectCatalog(null, factories(), 100);
    expect(result.projects[0]).toMatchObject({
      id: "018f00d2-8931-7bc0-aad1-1ec83b13f982",
      name: "Default",
      localReplica: { layout: "v2" },
    });
  });

  it("upgrades safe project IDs without reinterpreting them as v2 paths", () => {
    const result = upgradeProjectCatalog(
      [{ id: "proj_123", name: "Old", description: "", createdAt: 1, updatedAt: 2 }],
      factories(),
      100
    );
    expect(result.projects[0]).toMatchObject({
      id: "proj_123",
      legacyId: "proj_123",
      localReplica: { layout: "legacy-project" },
    });
  });

  it("never interprets an unsafe legacy ID as a filesystem path", () => {
    const result = upgradeProjectCatalog(
      [{ id: "../../escape", name: "Unsafe", description: "" }],
      factories(),
      100
    );
    expect(result.projects[0]).toMatchObject({
      id: "018f00d2-8931-7bc0-aad1-1ec83b13f982",
      legacyId: "../../escape",
      localReplica: { layout: "v2" },
    });
  });

  it("maps a stored legacy current ID to its migrated catalog record", () => {
    const result = upgradeProjectCatalog(
      [{ id: "../../escape", name: "Unsafe", description: "" }],
      factories(),
      100
    );
    expect(resolveStoredCurrentProjectId(result.projects, "../../escape")).toBe(
      "018f00d2-8931-7bc0-aad1-1ec83b13f982"
    );
  });

  it("promotes a legacy project without reusing its ID as a storage path", () => {
    const legacy = upgradeProjectCatalog(
      [{ id: "old-project", name: "Old", description: "" }],
      factories(),
      100
    ).projects[0];
    const promoted = promoteLegacyProjectToV2(
      legacy,
      () => "10ed836e-ae48-4d67-9e26-a74cbf55a52e",
      200
    );
    expect(promoted).toMatchObject({
      id: "10ed836e-ae48-4d67-9e26-a74cbf55a52e",
      legacyId: "old-project",
      localReplica: {
        layout: "v2",
        storageKey: legacy.localReplica.storageKey,
        id: legacy.localReplica.id,
      },
      updatedAt: 200,
    });
  });

  it("does not rewrite a valid v2 catalog record", () => {
    const existing = createProject("Existing", factories(), "", undefined, 100);
    const result = upgradeProjectCatalog([existing], factories(), 200);
    expect(result).toEqual({ projects: [existing], changed: false });
  });

  it("repairs invalid v2 replica metadata without reinterpreting its UUID as a legacy path", () => {
    const existing = createProject("Existing", factories(), "", undefined, 100);
    const result = upgradeProjectCatalog(
      [{ ...existing, localReplica: { ...existing.localReplica, storageKey: "../escape" } }],
      factories(),
      200
    );

    expect(result.projects[0]).toMatchObject({
      id: existing.id,
      localReplica: { layout: "v2" },
    });
    expect(result.projects[0].legacyId).toBeUndefined();
  });

  it("retains one remote replica per authority and connection route", () => {
    const project = createProject("Existing", factories(), "", undefined, 100);
    const first = upsertRemoteReplica(project, {
      id: "151d02d2-93b0-4a26-a50e-9f28eeb323b1",
      generation: 1,
      kind: "cloud",
      authorityId: "3ca2e8bb-4fe5-4e16-a6ca-99840d666870",
      connectionKey: "cloud:wss://one.example/ws",
      updatedAt: 200,
    });
    const recreated = upsertRemoteReplica(first, {
      id: "8bb713d6-3408-4f21-8df3-730fd2900c93",
      generation: 2,
      kind: "cloud",
      authorityId: "3ca2e8bb-4fe5-4e16-a6ca-99840d666870",
      connectionKey: "cloud:wss://one.example/ws",
      updatedAt: 300,
    });
    expect(recreated.remoteReplicas).toEqual([
      expect.objectContaining({
        id: "8bb713d6-3408-4f21-8df3-730fd2900c93",
        generation: 2,
      }),
    ]);
  });

  it("drops corrupt remote entries without replacing the local replica", () => {
    const project = createProject("Existing", factories(), "", undefined, 100);
    const result = upgradeProjectCatalog(
      [{ ...project, remoteReplicas: [{ id: "../escape" }] }],
      factories(),
      200
    );
    expect(result.changed).toBe(true);
    expect(result.projects[0].localReplica).toEqual(project.localReplica);
    expect(result.projects[0].remoteReplicas).toEqual([]);
  });

  it("stores an independent base for each local/remote replica edge", () => {
    const project = createProject("Demo", factories(), "", undefined, 1);
    const edge = {
      localReplicaId: project.localReplica.id,
      remoteReplicaId: "3ca2e8bb-4fe5-4e16-a6ca-99840d666870",
      remoteAuthorityId: "9d2b456e-6477-4c51-bf25-7680cf9f98d4",
      baseSnapshot: "a".repeat(64),
      localSnapshot: "a".repeat(64),
      remoteSnapshot: "a".repeat(64),
      baseRemoteRef: "b".repeat(40),
      phase: "committed" as const,
      updatedAt: 2,
    };
    const updated = upsertProjectSyncEdge(project, edge);
    expect(getProjectSyncEdge(updated, edge.remoteReplicaId)).toEqual(edge);
    expect(updated.lastSyncedCommit).toBeUndefined();
  });

  it("increments generation on a converged writer handoff and blocks conflicts", () => {
    const project = createProject("Demo", factories(), "", undefined, 1);
    const remoteId = "3ca2e8bb-4fe5-4e16-a6ca-99840d666870";
    const remoteWriter = handoffProjectWriterLease(project, remoteId, 2);
    const converged = upsertProjectSyncEdge(remoteWriter, {
      localReplicaId: project.localReplica.id,
      remoteReplicaId: remoteId,
      remoteAuthorityId: "9d2b456e-6477-4c51-bf25-7680cf9f98d4",
      baseSnapshot: "a".repeat(64),
      localSnapshot: "a".repeat(64),
      remoteSnapshot: "a".repeat(64),
      baseRemoteRef: "b".repeat(40),
      phase: "committed",
      updatedAt: 2,
    });
    const localWriter = handoffProjectWriterLease(converged, project.localReplica.id, 3);
    expect(localWriter.writerLease).toMatchObject({
      holderReplicaId: project.localReplica.id,
      generation: 2,
    });
    expect(localWriter.localReplica.generation).toBe(project.localReplica.generation + 1);

    const conflicted = upsertProjectSyncEdge(remoteWriter, {
      ...converged.syncEdges![0],
      phase: "conflict",
      remoteSnapshot: "c".repeat(64),
    });
    expect(() => handoffProjectWriterLease(conflicted, project.localReplica.id, 4)).toThrow(
      "requires all replica edges"
    );
  });

  it("persists copy source identity and explicit-only write-back policy", () => {
    const project = createImportedProject(
      "Imported",
      {
        mode: "copy",
        sourceKind: "directory",
        sourceDeviceId: "phone-a",
        canonicalLocator: "content://project-a",
        identity: {
          importMode: "copy",
          sourceKind: "directory",
          weakKeys: ['["locator","phone-a","directory","content://project-a"]'],
        },
        importedSnapshot: "snapshot-a",
        importedAt: 100,
        writeBackPolicy: "explicit",
      },
      factories(),
      100
    );
    expect(project.importSource).toMatchObject({
      canonicalLocator: "content://project-a",
      importedSnapshot: "snapshot-a",
      writeBackPolicy: "explicit",
    });
  });
});
