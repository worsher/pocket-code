import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerOutboundType } from "@pocket-code/wire";

vi.mock("./gitRemote.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gitRemote.js")>();
  return {
    ...actual,
    atomicCloneGitRepository: vi.fn(async ({ targetWorkspace }: { targetWorkspace: string }) => {
      mkdirSync(targetWorkspace, { recursive: true });
      writeFileSync(join(targetWorkspace, "README.md"), "cloned\n");
      return { head: "0123456789012345678901234567890123456789", branch: "main" };
    }),
  };
});

import { getWorkspaceProject, initDb } from "./db.js";
import { atomicCloneGitRepository } from "./gitRemote.js";
import { createMessageHandler } from "./messageHandler.js";

const roots: string[] = [];

beforeAll(async () => {
  await initDb();
});

afterEach(() => {
  vi.mocked(atomicCloneGitRepository).mockClear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.POCKET_CODE_DATA_ROOT;
});

describe("workspace-import-git handler", () => {
  it("commits Git import source metadata and rolls back a failed new project", async () => {
    const root = mkdtempSync(join(tmpdir(), "pc-handler-git-import-"));
    roots.push(root);
    process.env.POCKET_CODE_DATA_ROOT = join(root, "data");
    const userId = `git-import-user-${Date.now()}`;
    const sent: ServerOutboundType[] = [];
    const handler = createMessageHandler((message) => sent.push(message), {
      preAuth: { userId, deviceId: "daemon" },
      replicaKind: "dev-binding",
    });
    await handler.onMessage(
      JSON.stringify({
        type: "git-credential-upsert",
        _reqId: "upsert-import",
        profile: {
          id: "gitlab-import",
          provider: "gitlab",
          authKind: "pat",
          origin: "https://git.example.com",
        },
        secret: "import-test-token",
      })
    );

    const projectId = "4cf51786-17d0-4c02-b99f-c6e22ae4d127";
    await handler.onMessage(
      JSON.stringify({
        type: "workspace-import-git",
        _reqId: "import-success",
        projectId,
        displayName: "Imported Git project",
        repositoryUrl: "https://git.example.com/team/project.git",
        credentialProfileId: "gitlab-import",
      })
    );
    expect(sent.at(-1)).toMatchObject({
      type: "workspace-import-result",
      status: "imported",
      project: {
        projectId,
        displayName: "Imported Git project",
        importSource: {
          mode: "git",
          sourceKind: "git",
          canonicalLocator: "https://git.example.com/team/project.git",
          importedSnapshot: "0123456789012345678901234567890123456789",
          writeBackPolicy: "git",
        },
      },
    });
    expect(getWorkspaceProject(userId, projectId)?.importSource).toMatchObject({
      mode: "git",
      sourceKind: "git",
      writeBackPolicy: "git",
    });

    const failedProjectId = "8259b42d-f5a7-4c46-a23b-b561768613b5";
    vi.mocked(atomicCloneGitRepository).mockRejectedValueOnce(new Error("clone failed"));
    await handler.onMessage(
      JSON.stringify({
        type: "workspace-import-git",
        _reqId: "import-failure",
        projectId: failedProjectId,
        repositoryUrl: "https://git.example.com/team/missing.git",
        credentialProfileId: "gitlab-import",
      })
    );
    expect(sent.at(-1)).toMatchObject({
      type: "workspace-import-result",
      status: "error",
    });
    expect(getWorkspaceProject(userId, failedProjectId)).toBeNull();
    expect(existsSync(join(process.env.POCKET_CODE_DATA_ROOT!, "projects"))).toBe(true);
  });
});
