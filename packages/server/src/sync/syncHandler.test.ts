import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureGitRepo, handleSyncPull, handleSyncFile } from "./syncHandler.js";

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf-8" }).trim();
}

let ws: string;
let sent: any[];
const send = (m: unknown) => sent.push(m);

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "pc-sync-"));
  sent = [];
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

describe("syncHandler", () => {
  it("ensureGitRepo initializes a repo when none exists", async () => {
    expect(existsSync(join(ws, ".git"))).toBe(false);
    await ensureGitRepo(ws);
    expect(existsSync(join(ws, ".git"))).toBe(true);
    // idempotent
    await ensureGitRepo(ws);
    expect(existsSync(join(ws, ".git"))).toBe(true);
  });

  it("handleSyncPull on a fresh (non-git) workspace returns a full manifest", async () => {
    writeFileSync(join(ws, "a.txt"), "v1\n");
    writeFileSync(join(ws, "b.txt"), "v2\n");
    await handleSyncPull(ws, null, send);
    expect(sent).toHaveLength(1);
    const m = sent[0];
    expect(m.type).toBe("sync-manifest");
    expect(m.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(m.parent).toBeNull();
    const byPath = Object.fromEntries(m.files.map((f: any) => [f.path, f.status]));
    expect(byPath["a.txt"]).toBe("A");
    expect(byPath["b.txt"]).toBe("A");
  });

  it("handleSyncPull returns incremental changes since a prior commit", async () => {
    writeFileSync(join(ws, "a.txt"), "v1\n");
    await handleSyncPull(ws, null, send);
    const first = sent[0].commit;

    writeFileSync(join(ws, "a.txt"), "v2\n");
    writeFileSync(join(ws, "c.txt"), "new\n");
    sent = [];
    await handleSyncPull(ws, first, send);
    const m = sent[0];
    expect(m.parent).toBe(first);
    const byPath = Object.fromEntries(m.files.map((f: any) => [f.path, f.status]));
    expect(byPath["a.txt"]).toBe("M");
    expect(byPath["c.txt"]).toBe("A");
  });

  it("handleSyncPull falls back to full manifest when sinceCommit is unreachable", async () => {
    writeFileSync(join(ws, "a.txt"), "v1\n");
    await handleSyncPull(ws, "0000000000000000000000000000000000000000", send);
    const m = sent[0];
    expect(m.type).toBe("sync-manifest");
    // 回退为全量:a.txt 记为 A
    expect(m.files.some((f: any) => f.path === "a.txt" && f.status === "A")).toBe(true);
  });

  it("handleSyncFile returns base64 content that round-trips", async () => {
    writeFileSync(join(ws, "a.txt"), "hello sync\n");
    await handleSyncPull(ws, null, send);
    const commit = sent[0].commit;
    sent = [];
    await handleSyncFile(ws, commit, "a.txt", send);
    const m = sent[0];
    expect(m.type).toBe("sync-file-content");
    expect(m.path).toBe("a.txt");
    expect(m.encoding).toBe("base64");
    expect(Buffer.from(m.content, "base64").toString("utf-8")).toBe("hello sync\n");
  });

  it("handleSyncFile reports an error for a missing path", async () => {
    writeFileSync(join(ws, "a.txt"), "x\n");
    await handleSyncPull(ws, null, send);
    const commit = sent[0].commit;
    sent = [];
    await handleSyncFile(ws, commit, "does-not-exist.txt", send);
    const m = sent[0];
    expect(m.type).toBe("sync-file-content");
    expect(m.error).toBeTruthy();
  });

  it("echoes _reqId in sync-manifest and sync-file-content (for relay-mode correlation)", async () => {
    writeFileSync(join(ws, "a.txt"), "x\n");
    await handleSyncPull(ws, null, send, "req-1");
    expect(sent[0]._reqId).toBe("req-1");
    const commit = sent[0].commit;

    sent = [];
    await handleSyncFile(ws, commit, "a.txt", send, "req-2");
    expect(sent[0]._reqId).toBe("req-2");

    // 失败响应也回显
    sent = [];
    await handleSyncFile(ws, commit, "nope.txt", send, "req-3");
    expect(sent[0]._reqId).toBe("req-3");
    expect(sent[0].error).toBeTruthy();
  });
});
