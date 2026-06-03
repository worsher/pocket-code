// ── git 影子快照(发送端/开发机侧) ──────────────────────────
// 把工作区状态快照到私有 ref refs/pocket-code/worktree,绝不触碰用户的
// 分支/HEAD/暂存区。用独立 GIT_INDEX_FILE(置于 .git/pocket-code/ 下)隔离
// 暂存,故同步是"工作区版 Dropbox",用户 git 历史保持纯净。
// 详见 spec 第 4 节。

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const exec = promisify(execFile);
const SNAP_REF = "refs/pocket-code/worktree";
const MAX_BUFFER = 256 * 1024 * 1024;

// commit-tree 需要提交者身份;注入固定身份,使其在未配 user.name/email 的工作区也能工作。
const IDENTITY_ENV: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: "Pocket Code",
  GIT_AUTHOR_EMAIL: "pocket@local",
  GIT_COMMITTER_NAME: "Pocket Code",
  GIT_COMMITTER_EMAIL: "pocket@local",
};

async function git(repoDir: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await exec("git", args, {
    cwd: repoDir,
    env: env ? { ...process.env, ...env } : process.env,
    maxBuffer: MAX_BUFFER,
  });
  return stdout;
}

async function tryGit(repoDir: string, args: string[]): Promise<string | null> {
  try {
    return (await git(repoDir, args)).trim();
  } catch {
    return null;
  }
}

export interface SnapshotResult {
  /** 新快照 commit sha */
  commit: string;
  /** 上一快照 sha(增量基准);首次为 null */
  parent: string | null;
}

export type ChangeStatus = "A" | "M" | "D";
export interface ChangedFile {
  path: string;
  status: ChangeStatus;
}

/**
 * 对 repoDir 的当前工作区做零污染快照,提交到 refs/pocket-code/worktree。
 * 捕获已跟踪改动 + 未跟踪非忽略文件;遵守 .gitignore。
 */
export async function createSnapshot(repoDir: string): Promise<SnapshotResult> {
  const snapDir = join(repoDir, ".git", "pocket-code");
  await mkdir(snapDir, { recursive: true });
  const snapIdx = join(snapDir, "snapidx");
  // 必须指向不存在的索引(git 自建新索引);清掉可能残留的索引与锁
  await rm(snapIdx, { force: true });
  await rm(`${snapIdx}.lock`, { force: true });
  const env: NodeJS.ProcessEnv = { GIT_INDEX_FILE: snapIdx };

  try {
    await git(repoDir, ["add", "-A"], env);
    const tree = (await git(repoDir, ["write-tree"], env)).trim();
    const parent = await tryGit(repoDir, ["rev-parse", "--verify", "-q", SNAP_REF]);
    const commitArgs = ["commit-tree", tree];
    if (parent) commitArgs.push("-p", parent);
    commitArgs.push("-m", "pocket snapshot");
    const commit = (await git(repoDir, commitArgs, IDENTITY_ENV)).trim();
    await git(repoDir, ["update-ref", SNAP_REF, commit]);
    return { commit, parent: parent || null };
  } finally {
    await rm(snapIdx, { force: true });
    await rm(`${snapIdx}.lock`, { force: true });
  }
}

/**
 * 两快照间的增删改。fromCommit 为 null 时,返回 toCommit 全量文件(均记为 "A")。
 */
export async function changedFiles(
  repoDir: string,
  fromCommit: string | null,
  toCommit: string
): Promise<ChangedFile[]> {
  if (!fromCommit) {
    const out = await git(repoDir, ["ls-tree", "-r", "--name-only", toCommit]);
    return out
      .split("\n")
      .filter(Boolean)
      .map((path) => ({ path, status: "A" as const }));
  }
  // -z: NUL 分隔,稳健处理含空格/特殊字符的路径
  const out = await git(repoDir, ["diff", "--name-status", "-z", fromCommit, toCommit]);
  const parts = out.split("\0").filter(Boolean);
  const result: ChangedFile[] = [];
  // 格式: <status>\0<path>\0<status>\0<path>... (重命名会有两段路径,这里按 add/del 处理)
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const code = parts[i];
    const path = parts[i + 1];
    const status: ChangeStatus = code.startsWith("A")
      ? "A"
      : code.startsWith("D")
        ? "D"
        : "M";
    result.push({ path, status });
  }
  return result;
}

/** 读取某快照里某文件的内容(二进制安全)。 */
export async function readSnapshotFile(
  repoDir: string,
  commit: string,
  relPath: string
): Promise<Buffer> {
  const { stdout } = await exec("git", ["show", `${commit}:${relPath}`], {
    cwd: repoDir,
    encoding: "buffer",
    maxBuffer: MAX_BUFFER,
  });
  return stdout as Buffer;
}

/** 删除私有快照 ref(清理同步痕迹,不影响用户分支)。 */
export async function clearSnapshots(repoDir: string): Promise<void> {
  await tryGit(repoDir, ["update-ref", "-d", SNAP_REF]);
}
