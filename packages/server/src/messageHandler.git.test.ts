import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerOutboundType } from "@pocket-code/wire";
import { initDb } from "./db.js";
import { createMessageHandler } from "./messageHandler.js";

const roots: string[] = [];

beforeAll(async () => {
  await initDb();
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.POCKET_CODE_DATA_ROOT;
  delete process.env.WORKSPACE_ROOT;
  delete process.env.POCKET_CODE_WS_V2_SYNC;
});

function allFileContents(root: string): string {
  if (!readdirSync(root, { withFileTypes: true }).length) return "";
  const visit = (directory: string): string =>
    readdirSync(directory, { withFileTypes: true })
      .map((entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? visit(path) : readFileSync(path).toString("utf8");
      })
      .join("\n");
  return visit(root);
}

describe("messageHandler Git credentials", () => {
  it("stores a direct trusted PAT outside the workspace and deletes idempotently", async () => {
    const root = mkdtempSync(join(tmpdir(), "pc-handler-git-"));
    roots.push(root);
    process.env.POCKET_CODE_DATA_ROOT = join(root, "data");
    const sent: ServerOutboundType[] = [];
    const handler = createMessageHandler((message) => sent.push(message), {
      preAuth: { userId: `git-user-${Date.now()}`, deviceId: "daemon" },
      replicaKind: "dev-binding",
    });
    await handler.onMessage(
      JSON.stringify({
        type: "git-credential-upsert",
        _reqId: "credential-upsert-1",
        profile: {
          id: "custom-gitlab",
          provider: "gitlab",
          authKind: "pat",
          origin: "https://git.example.com:8443",
          pathPrefix: "/gitlab/team",
        },
        secret: "handler-sentinel-token",
      })
    );
    expect(sent.at(-1)).toMatchObject({
      type: "git-credential-result",
      operation: "upsert",
      success: true,
    });
    expect(allFileContents(process.env.POCKET_CODE_DATA_ROOT!)).not.toContain(
      "handler-sentinel-token"
    );

    await handler.onMessage(
      JSON.stringify({
        type: "git-credential-delete",
        _reqId: "credential-delete-1",
        credentialProfileId: "custom-gitlab",
      })
    );
    expect(sent.at(-1)).toMatchObject({ operation: "delete", success: true });
    await handler.onMessage(
      JSON.stringify({
        type: "git-credential-delete",
        _reqId: "credential-delete-2",
        credentialProfileId: "custom-gitlab",
      })
    );
    expect(sent.at(-1)).toMatchObject({ operation: "delete", success: true });
  });

  it("rejects plaintext PAT installation on an untrusted cloud transport", async () => {
    const root = mkdtempSync(join(tmpdir(), "pc-handler-git-plain-"));
    roots.push(root);
    process.env.POCKET_CODE_DATA_ROOT = join(root, "data");
    const sent: ServerOutboundType[] = [];
    const handler = createMessageHandler((message) => sent.push(message), {
      preAuth: { userId: `cloud-user-${Date.now()}`, deviceId: "phone" },
      replicaKind: "cloud",
    });
    await handler.onMessage(
      JSON.stringify({
        type: "git-credential-upsert",
        _reqId: "credential-untrusted",
        profile: {
          id: "github-main",
          provider: "github",
          authKind: "pat",
          origin: "https://github.com",
        },
        secret: "must-not-store",
      })
    );
    expect(sent.at(-1)).toMatchObject({
      type: "git-credential-result",
      success: false,
      error: { code: "encryption_required" },
    });
  });
});

describe("messageHandler sensitive file boundary", () => {
  it("filters list and rejects read/sync-file for credential paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "pc-handler-sensitive-"));
    roots.push(root);
    process.env.POCKET_CODE_DATA_ROOT = join(root, "data");
    process.env.WORKSPACE_ROOT = join(root, "workspaces");
    process.env.POCKET_CODE_WS_V2_SYNC = "1";
    const sent: ServerOutboundType[] = [];
    const handler = createMessageHandler((message) => sent.push(message), {
      preAuth: { userId: `file-user-${Date.now()}`, deviceId: "phone" },
      replicaKind: "cloud",
    });
    await handler.onMessage(
      JSON.stringify({ type: "init", sessionId: `sensitive-${Date.now()}` })
    );
    const session = sent.find((message) => message.type === "session");
    expect(session?.type).toBe("session");
    if (!session || session.type !== "session") throw new Error("session response missing");
    writeFileSync(join(session.workspace, "visible.txt"), "visible");
    writeFileSync(join(session.workspace, ".gitconfig"), "[user]\nname = user-owned\n");

    await handler.onMessage(JSON.stringify({ type: "list-files", path: ".", _reqId: "list-1" }));
    expect(JSON.stringify(sent.at(-1))).toContain("visible.txt");
    expect(JSON.stringify(sent.at(-1))).not.toContain(".gitconfig");

    await handler.onMessage(
      JSON.stringify({ type: "read-file", path: ".gitconfig", _reqId: "read-1" })
    );
    expect(sent.at(-1)).toMatchObject({
      type: "file-content",
      success: false,
      error: "Sensitive workspace path is not accessible",
    });

    await handler.onMessage(
      JSON.stringify({
        type: "sync-file",
        commit: "0123456789012345678901234567890123456789",
        path: ".gitconfig",
        _reqId: "sync-1",
      })
    );
    expect(sent.at(-1)).toMatchObject({
      type: "sync-file-content",
      error: "Sensitive workspace path is not accessible",
    });
  });
});
