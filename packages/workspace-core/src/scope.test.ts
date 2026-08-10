import { describe, expect, it } from "vitest";
import { parseProjectId, parseReplicaId } from "./ids.js";
import { createWorkspaceScope, isSameWorkspaceScope } from "./scope.js";

const scope = {
  projectId: parseProjectId("018f00d2-8931-7bc0-aad1-1ec83b13f982"),
  replicaId: parseReplicaId("550e8400-e29b-41d4-a716-446655440000"),
  sessionId: "session-1",
  workspaceGeneration: 3,
};

describe("isSameWorkspaceScope", () => {
  it("requires project, replica, session, and generation to match", () => {
    expect(isSameWorkspaceScope(scope, { ...scope })).toBe(true);
    expect(isSameWorkspaceScope(scope, { ...scope, sessionId: "session-2" })).toBe(false);
    expect(isSameWorkspaceScope(scope, { ...scope, workspaceGeneration: 4 })).toBe(false);
    expect(
      isSameWorkspaceScope(scope, {
        ...scope,
        replicaId: parseReplicaId("74f1d64f-bf59-46a9-aa0b-7dcf42b95cab"),
      })
    ).toBe(false);
  });

  it("validates UUID and migration-only legacy project scopes", () => {
    expect(
      createWorkspaceScope({
        projectId: "default",
        replicaId: "550e8400-e29b-41d4-a716-446655440000",
        sessionId: "session-1",
        workspaceGeneration: 1,
      }).projectId,
    ).toBe("default");
    expect(() =>
      createWorkspaceScope({
        projectId: "../escape",
        replicaId: "550e8400-e29b-41d4-a716-446655440000",
        sessionId: "session-1",
        workspaceGeneration: 1,
      }),
    ).toThrow();
    expect(() =>
      createWorkspaceScope({
        projectId: "default",
        replicaId: "550e8400-e29b-41d4-a716-446655440000",
        sessionId: "",
        workspaceGeneration: 0,
      }),
    ).toThrow();
  });
});
