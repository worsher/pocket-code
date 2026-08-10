import { beforeEach, describe, expect, it, vi } from "vitest";

const ensureWorkspaceProjectMock = vi.fn((userId: string) => ({
  replicaId: "550e8400-e29b-41d4-a716-446655440000",
  storageKey:
    userId === "user-a"
      ? "ws_550e8400e29b41d4a716446655440000"
      : "ws_74f1d64fbf5946a9aa0b7dcf42b95cab",
  generation: 1,
}));

vi.mock("./db.js", () => ({
  ensureWorkspaceProject: (...args: unknown[]) => ensureWorkspaceProjectMock(...(args as [string])),
}));

const { getWorkspaceHandle, getWorkspaceRoot } = await import("./tools.js");
const PROJECT_ID = "018f00d2-8931-7bc0-aad1-1ec83b13f982";

beforeEach(() => {
  ensureWorkspaceProjectMock.mockClear();
  process.env.POCKET_CODE_DATA_ROOT = "/srv/pocket-code/v2";
  process.env.PROJECTS_ROOT = "/srv/pocket-code/legacy-projects";
  process.env.WORKSPACE_ROOT = "/srv/pocket-code/legacy-sessions";
});

describe("server workspace resolver", () => {
  it("maps the same project UUID to user-scoped opaque storage keys", () => {
    const first = getWorkspaceRoot({ sessionId: "", projectId: PROJECT_ID, userId: "user-a" });
    const second = getWorkspaceRoot({ sessionId: "", projectId: PROJECT_ID, userId: "user-b" });

    expect(first).toBe("/srv/pocket-code/v2/projects/ws_550e8400e29b41d4a716446655440000/worktree");
    expect(second).toBe(
      "/srv/pocket-code/v2/projects/ws_74f1d64fbf5946a9aa0b7dcf42b95cab/worktree"
    );
    expect(first).not.toContain(PROJECT_ID);
    expect(first).not.toBe(second);
  });

  it("requires user scope for v2 projects", () => {
    expect(() => getWorkspaceRoot({ sessionId: "", projectId: PROJECT_ID })).toThrow("User ID");
  });

  it("returns a complete WorkspaceHandle for v2 consumers", () => {
    expect(
      getWorkspaceHandle({ sessionId: "session-1", projectId: PROJECT_ID, userId: "user-a" })
    ).toMatchObject({
      projectId: PROJECT_ID,
      replicaId: "550e8400-e29b-41d4-a716-446655440000",
      generation: 1,
      storageUri:
        "file:///srv/pocket-code/v2/projects/ws_550e8400e29b41d4a716446655440000/worktree",
      shellPath: "/srv/pocket-code/v2/projects/ws_550e8400e29b41d4a716446655440000/worktree",
      stateRoot: "/srv/pocket-code/v2/projects/ws_550e8400e29b41d4a716446655440000/state",
      cacheRoot: "/srv/pocket-code/v2/projects/ws_550e8400e29b41d4a716446655440000/cache",
    });
  });

  it("keeps safe legacy project and session paths compatible", () => {
    expect(getWorkspaceRoot({ sessionId: "", projectId: "proj_123", userId: "user-a" })).toBe(
      "/srv/pocket-code/legacy-projects/proj_123/workspace"
    );
    expect(getWorkspaceRoot({ sessionId: "session-123" })).toBe(
      "/srv/pocket-code/legacy-sessions/session-123"
    );
  });

  it.each(["../escape", "a/b", "a\\b", "/absolute"])(
    "rejects unsafe legacy path key %s",
    (projectId) => {
      expect(() => getWorkspaceRoot({ sessionId: "", projectId, userId: "user-a" })).toThrow();
    }
  );
});
