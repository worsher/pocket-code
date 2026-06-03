import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSnapshot,
  changedFiles,
  readSnapshotFile,
  clearSnapshots,
} from "./shadowSnapshot.js";

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf-8" }).trim();
}

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "pc-snap-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t.co");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  writeFileSync(join(repo, "a.txt"), "v1\n");
  mkdirSync(join(repo, "sub"));
  writeFileSync(join(repo, "sub", "b.txt"), "nested\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("shadowSnapshot", () => {
  it("captures working-tree changes without polluting branch/HEAD/index/status", async () => {
    // dirty the tree: modify tracked, add untracked, add ignored
    writeFileSync(join(repo, "a.txt"), "modified\n");
    writeFileSync(join(repo, "c.txt"), "new\n");
    mkdirSync(join(repo, "node_modules"));
    writeFileSync(join(repo, "node_modules", "x.js"), "junk\n");

    const headBefore = git(repo, "rev-parse", "HEAD");
    const branchBefore = git(repo, "rev-parse", "refs/heads/main");
    const statusBefore = git(repo, "status", "--porcelain");
    const stagedBefore = git(repo, "diff", "--cached", "--name-only"); // 暂存区内容(应为空)

    const snap = await createSnapshot(repo);
    expect(snap.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(snap.parent).toBeNull();

    // ── zero pollution ──
    expect(git(repo, "rev-parse", "HEAD")).toBe(headBefore);
    expect(git(repo, "rev-parse", "refs/heads/main")).toBe(branchBefore);
    // 工作区状态与暂存区内容均未被快照改变(不依赖 index 文件 mtime,避免 git status 刷新 stat-cache 造成 flaky)
    expect(git(repo, "status", "--porcelain")).toBe(statusBefore);
    expect(git(repo, "diff", "--cached", "--name-only")).toBe(stagedBefore);
    // private ref exists
    expect(git(repo, "rev-parse", "refs/pocket-code/worktree")).toBe(snap.commit);

    // ── snapshot tree content (gitignore respected, no stray index/lock) ──
    const tree = git(repo, "ls-tree", "-r", "--name-only", snap.commit).split("\n").sort();
    expect(tree).toEqual([".gitignore", "a.txt", "c.txt", "sub/b.txt"]);
  });

  it("computes incremental changes between two snapshots", async () => {
    const s1 = await createSnapshot(repo);

    writeFileSync(join(repo, "a.txt"), "changed\n");     // modify
    writeFileSync(join(repo, "new.txt"), "added\n");      // add
    rmSync(join(repo, "sub", "b.txt"));                   // delete
    const s2 = await createSnapshot(repo);

    expect(s2.parent).toBe(s1.commit);

    const changes = await changedFiles(repo, s1.commit, s2.commit);
    const byPath = Object.fromEntries(changes.map((c) => [c.path, c.status]));
    expect(byPath["a.txt"]).toBe("M");
    expect(byPath["new.txt"]).toBe("A");
    expect(byPath["sub/b.txt"]).toBe("D");
    expect(Object.keys(byPath).sort()).toEqual(["a.txt", "new.txt", "sub/b.txt"]);
  });

  it("lists all files as added when fromCommit is null", async () => {
    const s1 = await createSnapshot(repo);
    const all = await changedFiles(repo, null, s1.commit);
    expect(all.every((c) => c.status === "A")).toBe(true);
    expect(all.map((c) => c.path).sort()).toEqual([".gitignore", "a.txt", "sub/b.txt"]);
  });

  it("reads a file's content from a snapshot (text + binary-safe)", async () => {
    writeFileSync(join(repo, "a.txt"), "hello snapshot\n");
    const bin = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
    writeFileSync(join(repo, "blob.bin"), bin);
    const snap = await createSnapshot(repo);

    const text = await readSnapshotFile(repo, snap.commit, "a.txt");
    expect(text.toString("utf-8")).toBe("hello snapshot\n");

    const back = await readSnapshotFile(repo, snap.commit, "blob.bin");
    expect(Buffer.compare(back, bin)).toBe(0);
  });

  it("clearSnapshots removes the private ref and leaves the repo pristine", async () => {
    await createSnapshot(repo);
    expect(git(repo, "rev-parse", "refs/pocket-code/worktree")).toMatch(/^[0-9a-f]{40}$/);
    await clearSnapshots(repo);
    // ref gone
    const refs = git(repo, "for-each-ref", "refs/pocket-code/");
    expect(refs).toBe("");
    // branch/HEAD untouched
    expect(git(repo, "rev-parse", "HEAD")).toMatch(/^[0-9a-f]{40}$/);
  });
});
