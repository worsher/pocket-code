import { describe, expect, it } from "vitest";
import { resolveWorkspaceEntry } from "./workspacePath.js";

describe("resolveWorkspaceEntry", () => {
  const root = "/srv/workspaces/project/worktree";

  it("resolves a normalized path inside the worktree", () => {
    expect(resolveWorkspaceEntry(root, "src//./index.ts")).toBe(
      "/srv/workspaces/project/worktree/src/index.ts"
    );
  });

  it.each(["../worktree-copy/secret", "/etc/passwd", "%2e%2e/secret", "C:\\Windows\\system.ini"])(
    "rejects traversal path %s",
    (path) => {
      expect(() => resolveWorkspaceEntry(root, path)).toThrow();
    }
  );
});
