import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveWorkspaceEntry, resolveWorkspaceEntryChecked } from "./workspacePath.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

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

  it("rejects an HTTP file path whose symlink resolves outside the worktree", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "pocket-code-http-workspace-"));
    const external = mkdtempSync(join(tmpdir(), "pocket-code-http-external-"));
    temporaryDirectories.push(workspace, external);
    writeFileSync(join(external, "secret.txt"), "secret");
    symlinkSync(external, join(workspace, "escape"), "dir");

    await expect(
      resolveWorkspaceEntryChecked(workspace, "escape/secret.txt", { allowMissing: true })
    ).rejects.toThrow("outside");
  });
});
