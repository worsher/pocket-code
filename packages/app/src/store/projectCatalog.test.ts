import { describe, expect, it } from "vitest";
import {
  createProject,
  resolveStoredCurrentProjectId,
  upgradeProjectCatalog,
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
      200,
    );

    expect(result.projects[0]).toMatchObject({
      id: existing.id,
      localReplica: { layout: "v2" },
    });
    expect(result.projects[0].legacyId).toBeUndefined();
  });
});
