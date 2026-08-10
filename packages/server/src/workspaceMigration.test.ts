import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getManagedWorkspaceRelativeRoots } from "@pocket-code/workspace-core";
import type { ServerOutboundType } from "@pocket-code/wire";
import { getSession, getWorkspaceProject, initDb, saveSession } from "./db.js";
import { createMessageHandler } from "./messageHandler.js";
import {
  cleanupLegacyServerWorkspace,
  migrateLegacyServerWorkspace,
} from "./workspaceMigration.js";

const PROJECT_ID = "10ed836e-ae48-4d67-9e26-a74cbf55a52e";
let root: string;
let source: string;

beforeAll(async () => {
  await initDb();
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pc-workspace-migration-"));
  process.env.PROJECTS_ROOT = join(root, "legacy-projects");
  process.env.POCKET_CODE_DATA_ROOT = join(root, "v2");
  source = join(process.env.PROJECTS_ROOT, "old-project", "workspace");
  mkdirSync(join(source, "src"), { recursive: true });
  writeFileSync(join(source, "src", "index.ts"), "export const migrated = true\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("legacy server workspace migration", () => {
  it("stages, verifies, atomically registers, and preserves the old root", async () => {
    const userId = `migration-user-${Date.now()}`;
    saveSession("legacy-session", userId, [], "deepseek-v4-flash", "old-project");
    const record = await migrateLegacyServerWorkspace({
      userId,
      legacyProjectId: "old-project",
      projectId: PROJECT_ID,
      displayName: "Old project",
    });
    expect(record).not.toBeNull();
    const roots = getManagedWorkspaceRelativeRoots(record!.storageKey);
    const migratedFile = join(
      process.env.POCKET_CODE_DATA_ROOT!,
      roots.worktreeRoot,
      "src/index.ts"
    );
    expect(readFileSync(migratedFile, "utf8")).toBe("export const migrated = true\n");
    expect(existsSync(source)).toBe(true);
    expect(getSession("legacy-session")?.projectId).toBe(PROJECT_ID);
    expect(getWorkspaceProject(userId, PROJECT_ID)).toMatchObject({
      replicaId: record!.replicaId,
      storageKey: record!.storageKey,
      displayName: "Old project",
    });

    await expect(
      migrateLegacyServerWorkspace({
        userId,
        legacyProjectId: "old-project",
        projectId: PROJECT_ID,
      })
    ).resolves.toMatchObject({ storageKey: record!.storageKey });
    await expect(
      cleanupLegacyServerWorkspace({
        userId,
        legacyProjectId: "old-project",
        projectId: PROJECT_ID,
      })
    ).resolves.toBe(true);
    expect(existsSync(source)).toBe(false);
    await expect(
      cleanupLegacyServerWorkspace({
        userId,
        legacyProjectId: "old-project",
        projectId: PROJECT_ID,
      })
    ).resolves.toBe(false);
  });

  it("rejects symbolic links without catalog commit or source deletion", async () => {
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "outside");
    symlinkSync(outside, join(source, "escape-link"));
    const userId = `migration-link-user-${Date.now()}`;
    await expect(
      migrateLegacyServerWorkspace({
        userId,
        legacyProjectId: "old-project",
        projectId: PROJECT_ID,
      })
    ).rejects.toThrow("symbolic links");
    expect(existsSync(source)).toBe(true);
    expect(getWorkspaceProject(userId, PROJECT_ID)).toBeNull();
  });

  it("migrates on v2 init and cleans only after the explicit authenticated RPC", async () => {
    const sent: ServerOutboundType[] = [];
    const userId = `migration-handler-user-${Date.now()}`;
    const handler = createMessageHandler((message) => sent.push(message), {
      preAuth: { userId, deviceId: "phone" },
      replicaKind: "cloud",
    });
    await handler.onMessage(
      JSON.stringify({
        type: "init",
        workspaceProtocolVersion: 2,
        sessionId: `migration-handler-session-${Date.now()}`,
        projectId: PROJECT_ID,
        legacyProjectId: "old-project",
        projectName: "Migrated by init",
      })
    );
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: "session",
        projectId: PROJECT_ID,
        workspaceProtocolVersion: 2,
      })
    );
    expect(existsSync(source)).toBe(true);

    await handler.onMessage(
      JSON.stringify({
        type: "workspace-legacy-cleanup",
        _reqId: "legacy-cleanup-1",
        projectId: PROJECT_ID,
        legacyProjectId: "old-project",
      })
    );
    expect(sent.at(-1)).toMatchObject({
      type: "workspace-legacy-cleaned",
      _reqId: "legacy-cleanup-1",
      success: true,
      cleaned: true,
    });
    expect(existsSync(source)).toBe(false);
  });
});
