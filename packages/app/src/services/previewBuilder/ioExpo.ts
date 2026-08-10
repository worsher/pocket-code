// BuilderIo 的 expo 实现(薄适配,不进 vitest —— 决策逻辑全在 orchestrator)。
import {
  readLocalFile,
  readLocalFileBase64,
  writeLocalFile,
  type MobileWorkspaceTarget,
} from "../localFileSystem";
import { readCachedDep, writeCachedDep } from "./depCache";
import type { BuilderIo } from "./orchestrator";

export function createExpoIo(workspaceTarget: MobileWorkspaceTarget): BuilderIo {
  return {
    readTextFile: async (rel) => {
      const r = await readLocalFile(rel, workspaceTarget);
      return { ok: r.success, content: r.content, error: r.error };
    },
    readBinaryBase64: async (rel) => {
      const r = await readLocalFileBase64(rel, workspaceTarget);
      return { ok: r.success, base64: r.content, error: r.error };
    },
    writeDistFile: async (rel, content) => {
      const r = await writeLocalFile("dist/" + rel, content, workspaceTarget);
      return { ok: r.success, error: r.error };
    },
    readCache: readCachedDep,
    writeCache: writeCachedDep,
  };
}
