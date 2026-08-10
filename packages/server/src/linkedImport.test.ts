import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initDb } from "./db.js";
import { bindLinkedDirectory } from "./linkedImport.js";
import { getWorkspaceHandle } from "./tools.js";
import { handleSyncPull } from "./sync/syncHandler.js";

const PROJECT_A = "018f00d2-8931-7bc0-aad1-1ec83b13f982";
const PROJECT_B = "550e8400-e29b-41d4-a716-446655440000";

let root: string;
let source: string;

beforeAll(async () => {
  await initDb();
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pc-linked-"));
  source = join(root, "existing-project");
  const data = join(root, "managed");
  process.env.POCKET_CODE_DATA_ROOT = data;
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "index.ts"), "export const linked = true\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("daemon linked workspace import", () => {
  it("keeps the worktree external while state and shadow Git stay managed", async () => {
    const result = await bindLinkedDirectory({
      userId: "linked-user-a",
      projectId: PROJECT_A,
      path: source,
    });
    expect(result.status).toBe("imported");
    if (result.status !== "imported") throw new Error("expected linked import");

    const handle = getWorkspaceHandle({
      sessionId: "",
      projectId: PROJECT_A,
      userId: "linked-user-a",
    });
    expect(handle.worktreeRoot).toBe(realpathSync(resolve(source)));
    expect(handle.stateRoot).toContain(join(root, "managed", "projects"));

    const sent: unknown[] = [];
    await handleSyncPull(
      source,
      null,
      (message) => sent.push(message),
      undefined,
      handle.stateRoot
    );
    expect(sent).toHaveLength(1);
    expect(existsSync(join(source, ".git"))).toBe(false);
    expect(existsSync(join(handle.stateRoot, "shadow-snapshot", ".git"))).toBe(true);
  });

  it("strongly blocks binding the same physical directory twice", async () => {
    const first = await bindLinkedDirectory({
      userId: "linked-user-b",
      projectId: PROJECT_A,
      path: source,
    });
    expect(first.status).toBe("imported");
    const repeated = await bindLinkedDirectory({
      userId: "linked-user-b",
      projectId: PROJECT_B,
      path: source,
      allowWeakDuplicate: true,
    });
    expect(repeated).toMatchObject({
      status: "blocked",
      existingProjectId: PROJECT_A,
    });
  });

  it("rejects a missing or inaccessible source before catalog commit", async () => {
    await expect(
      bindLinkedDirectory({
        userId: "linked-user-c",
        projectId: PROJECT_A,
        path: join(root, "missing"),
      })
    ).rejects.toThrow();
  });
});
