import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerOutboundType } from "@pocket-code/wire";
import { initDb } from "./db.js";
import { createMessageHandler } from "./messageHandler.js";

const PROJECT_ID = "10ed836e-ae48-4d67-9e26-a74cbf55a52e";
let root: string;
let source: string;

beforeAll(async () => {
  await initDb();
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pc-linked-handler-"));
  source = join(root, "project");
  mkdirSync(source, { recursive: true });
  process.env.POCKET_CODE_DATA_ROOT = join(root, "managed");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("linked workspace RPC authorization", () => {
  it("allows a trusted dev-binding daemon and returns catalog metadata", async () => {
    const sent: ServerOutboundType[] = [];
    const handler = createMessageHandler((message) => sent.push(message), {
      replicaKind: "dev-binding",
      allowLinkedWorkspaceBinding: true,
      preAuth: { userId: "linked-handler-user", deviceId: "phone" },
    });
    await handler.onMessage(
      JSON.stringify({
        type: "workspace-bind-linked",
        _reqId: "req-1",
        projectId: PROJECT_ID,
        path: source,
      })
    );
    expect(sent.at(-1)).toMatchObject({
      type: "workspace-import-result",
      _reqId: "req-1",
      status: "imported",
      project: { projectId: PROJECT_ID, replicaKind: "dev-binding" },
      importSource: { mode: "linked", writeBackPolicy: "linked" },
    });

    await handler.onMessage(
      JSON.stringify({ type: "delete-project-workspace", projectId: PROJECT_ID })
    );
    expect(sent.at(-1)).toMatchObject({
      type: "project-workspace-deleted",
      projectId: PROJECT_ID,
      success: true,
    });
    expect(existsSync(source)).toBe(true);
  });

  it("rejects host paths on the normal cloud handler", async () => {
    const sent: ServerOutboundType[] = [];
    const handler = createMessageHandler((message) => sent.push(message), {
      replicaKind: "cloud",
      preAuth: { userId: "cloud-handler-user", deviceId: "phone" },
    });
    await handler.onMessage(
      JSON.stringify({
        type: "workspace-bind-linked",
        _reqId: "req-2",
        projectId: PROJECT_ID,
        path: source,
      })
    );
    expect(sent.at(-1)).toMatchObject({
      type: "workspace-import-result",
      _reqId: "req-2",
      status: "error",
    });
  });
});
