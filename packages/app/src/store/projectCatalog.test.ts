import { describe, expect, it } from "vitest";
import {
  createProject,
  createProjectFromRemote,
  createImportedProject,
  resolveStoredCurrentProjectId,
  upgradeProjectCatalog,
  upsertRemoteReplica,
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
    const result = upgradeProjectCatalog(null, factories(), 100);
    expect(result.changed).toBe(true);
    expect(result.projects[0]).toMatchObject({
      id: "default",
      legacyId: "default",
      localReplica: { layout: "legacy-default" },
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
