// ── 代码同步·接收端(手机侧) ────────────────────────────────
// 从开发机拉取影子快照增量到手机本地工作区:拉 manifest → 对 A/M 文件取
// base64 内容写入,对 D 文件删除。requestSyncPull/requestSyncFile 由 useAgent
// 提供(内部走 WS 直连或 relay,按 _reqId 关联响应),本服务只做编排,便于复用。

import {
  writeLocalFileBase64,
  deleteLocalFile,
  getProjectWorkspaceRoot,
  getDefaultWorkspace,
} from "./localFileSystem";

export interface SyncManifestFile {
  path: string;
  status: "A" | "M" | "D";
}

export interface SyncManifest {
  commit: string;
  parent: string | null;
  files: SyncManifestFile[];
}

export interface SyncFileContent {
  path: string;
  content?: string;
  encoding?: string;
  error?: string;
}

export interface PullDeps {
  /** 发送 sync-pull,等待 sync-manifest。 */
  requestSyncPull: (sinceCommit?: string) => Promise<SyncManifest>;
  /** 发送 sync-file,等待 sync-file-content。 */
  requestSyncFile: (commit: string, path: string) => Promise<SyncFileContent>;
  /** 当前项目 id(决定写入哪个工作区);default/空→共享工作区。 */
  projectId?: string;
  /** 上次同步到的 commit(增量基准);为空则全量拉取。 */
  sinceCommit?: string | null;
  onProgress?: (msg: string) => void;
}

export interface PullResult {
  success: boolean;
  /** 本次同步到的快照 commit(成功时);供持久化为下次的 sinceCommit。 */
  commit?: string;
  applied: number;
  deleted: number;
  failed: string[];
  error?: string;
}

/**
 * 从开发机拉取代码到手机本地工作区。
 */
export async function pullFromDevMachine(deps: PullDeps): Promise<PullResult> {
  const { requestSyncPull, requestSyncFile, projectId, sinceCommit, onProgress } = deps;
  const workspaceRoot = getProjectWorkspaceRoot(projectId) ?? getDefaultWorkspace();
  try {
    const manifest = await requestSyncPull(sinceCommit ?? undefined);
    let applied = 0;
    let deleted = 0;
    const failed: string[] = [];

    for (const f of manifest.files) {
      if (f.status === "D") {
        await deleteLocalFile(f.path, workspaceRoot);
        deleted++;
        onProgress?.(`− ${f.path}`);
        continue;
      }
      const res = await requestSyncFile(manifest.commit, f.path);
      if (res.error || typeof res.content !== "string") {
        failed.push(f.path);
        continue;
      }
      // sync-file-content 为 base64;直接写解码字节(文本+二进制均正确)。
      const w = await writeLocalFileBase64(f.path, res.content, workspaceRoot);
      if (w.success) {
        applied++;
        onProgress?.(`✓ ${f.path}`);
      } else {
        failed.push(f.path);
      }
    }

    return {
      success: failed.length === 0,
      commit: manifest.commit,
      applied,
      deleted,
      failed,
    };
  } catch (err: any) {
    return {
      success: false,
      applied: 0,
      deleted: 0,
      failed: [],
      error: err?.message ?? "sync failed",
    };
  }
}
