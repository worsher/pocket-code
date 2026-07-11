// BuilderIo 的 expo 实现(薄适配,不进 vitest —— 决策逻辑全在 orchestrator)。
import { Paths, File } from "expo-file-system";
import { readLocalFile, writeLocalFile } from "../localFileSystem";
import { readCachedDep, writeCachedDep } from "./depCache";
import type { BuilderIo } from "./orchestrator";

export function createExpoIo(workspaceRoot: string | undefined): BuilderIo {
  return {
    readTextFile: async (rel) => {
      const r = await readLocalFile(rel, workspaceRoot);
      return { ok: r.success, content: r.content, error: r.error };
    },
    readBinaryBase64: async (rel) => {
      try {
        const root = workspaceRoot ?? new File(Paths.document, "workspace").uri;
        const f = new File(root, rel);
        if (!f.exists) return { ok: false, error: "File does not exist" };
        return { ok: true, base64: await f.base64() };
      } catch (e: any) {
        return { ok: false, error: e.message };
      }
    },
    writeDistFile: async (rel, content) => {
      const r = await writeLocalFile("dist/" + rel, content, workspaceRoot);
      return { ok: r.success, error: r.error };
    },
    readCache: readCachedDep,
    writeCache: writeCachedDep,
  };
}
