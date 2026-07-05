// ── sync 服务端 handler(发送端/开发机侧) ───────────────────
// 把影子快照接成同步协议:sync-pull → 快照+增量清单;sync-file → 文件内容。
// 接收 workspace 路径 + send 回调,与 messageHandler/DB/auth 解耦,便于单测。

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ServerOutboundType } from "@pocket-code/wire";
import {
  createSnapshot,
  changedFiles,
  readSnapshotFile,
  type ChangedFile,
} from "./shadowSnapshot.js";

const exec = promisify(execFile);

/** 工作区不是 git 仓库时,初始化一个(同步需要 git 做快照)。 */
export async function ensureGitRepo(workspace: string): Promise<void> {
  if (!existsSync(join(workspace, ".git"))) {
    await exec("git", ["init", "-q"], { cwd: workspace });
  }
}

/**
 * 处理 sync-pull:对工作区做影子快照,返回相对 sinceCommit 的增量清单。
 * sinceCommit 不可达(如手机记录的旧 commit 已被清理)时回退为全量。
 */
export async function handleSyncPull(
  workspace: string,
  sinceCommit: string | null,
  send: (msg: unknown) => void,
  reqId?: string
): Promise<void> {
  await ensureGitRepo(workspace);
  const snap = await createSnapshot(workspace);
  let files: ChangedFile[];
  try {
    files = await changedFiles(workspace, sinceCommit, snap.commit);
  } catch {
    // sinceCommit 不可达 → 回退全量
    files = await changedFiles(workspace, null, snap.commit);
  }
  // _reqId 回显:relay 模式下 RelayClient 拆信封会丢 requestId,响应须自带 _reqId 供客户端关联。
  send({ type: "sync-manifest", commit: snap.commit, parent: snap.parent, files, _reqId: reqId } satisfies ServerOutboundType);
}

/** 处理 sync-file:返回某快照里某文件的 base64 内容(失败则带 error)。 */
export async function handleSyncFile(
  workspace: string,
  commit: string,
  path: string,
  send: (msg: unknown) => void,
  reqId?: string
): Promise<void> {
  try {
    const content = await readSnapshotFile(workspace, commit, path);
    send({
      type: "sync-file-content",
      path,
      encoding: "base64",
      content: content.toString("base64"),
      _reqId: reqId,
    } satisfies ServerOutboundType);
  } catch (err: any) {
    send({ type: "sync-file-content", path, error: err?.message ?? "read failed", _reqId: reqId } satisfies ServerOutboundType);
  }
}
