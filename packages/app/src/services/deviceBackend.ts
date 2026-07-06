// ── DeviceBackend ──────────────────────────────────────
// RuntimeBackend 实现,供 App 侧 geek 模式的 runAgentLoop 使用。
// 对照 packages/server/src/nodeBackend.ts(server 侧 RuntimeBackend 实现)。
//
// readFile/writeFile/listFiles → localFileSystem 的 readLocalFile/writeLocalFile/
// listLocalFiles(路径基 getProjectWorkspaceRoot(projectId) ?? getDefaultWorkspace())。
// exec → execTool("runCommand", {command}),解析其 {success,stdout,stderr,error} 回
// ExecResult(core registry 的 runCommandTool 按 exitCode===0 判定成功——见
// packages/agent-core/src/tools/execTools.ts runCommandTool)。
// startProcess/stopProcess → execTool("runInBackground"/"stopProcess", ...)(保持 geek
// 现有能力;App 侧 processId 是 number——见 processManager.ts,RuntimeBackend 契约是
// string——见 agent-core/src/tools/execTools.ts stopProcessSchema,这里做双向转换)。

import type { ExecResult, RuntimeBackend } from "@pocket-code/agent-core";
import {
  readLocalFile,
  writeLocalFile,
  listLocalFiles,
  getProjectWorkspaceRoot,
  getDefaultWorkspace,
} from "./localFileSystem";

/**
 * runAgentLoop 调用形态里 workspace 固定传 "/"(DeviceBackend 内部已定根,safePath
 * 以 "/" 为界)。core 的 safePath(workspace, path) 会产出以 "/" 开头的绝对路径(如
 * "/a/b.ts"),而 localFileSystem 的 read/write/listLocalFiles 把传入路径当作相对于
 * workspaceRoot 的相对路径解析——所以这里要把前导 "/" 剥掉,避免 "//a/b.ts" 之类的
 * 双斜杠路径(expo-file-system Directory/File 构造函数按字符串拼接,不会自动规范化)。
 */
export function toRelativePath(fullPath: string): string {
  return fullPath.replace(/^\/+/, "") || ".";
}

/** 解析 execTool("runCommand", ...) 的返回值为 core ExecResult。不抛出。 */
export function parseExecResult(result: unknown): ExecResult {
  const r = (result ?? {}) as {
    success?: boolean;
    stdout?: string;
    stderr?: string;
    error?: string;
    exitCode?: number;
  };
  if (typeof r.exitCode === "number") {
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.exitCode };
  }
  if (r.success === false) {
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? r.error ?? "", exitCode: 1 };
  }
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: 0 };
}

export interface CreateDeviceBackendOpts {
  projectId?: string;
  execTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

export function createDeviceBackend(opts: CreateDeviceBackendOpts): RuntimeBackend {
  const { projectId, execTool } = opts;
  const workspaceRoot = () => getProjectWorkspaceRoot(projectId) ?? getDefaultWorkspace();

  return {
    async readFile(path: string): Promise<string> {
      const rel = toRelativePath(path);
      const result = await readLocalFile(rel, workspaceRoot());
      if (!result.success) {
        throw new Error(result.error || "Failed to read file");
      }
      return result.content ?? "";
    },

    async writeFile(path: string, content: string): Promise<{ isNew: boolean }> {
      const rel = toRelativePath(path);
      // localFileSystem.writeLocalFile 不返回 isNew;沿用 core writeFileTool 的
      // "写入前先 readFile 探测存在性" 模式来判定(见 fileTools.ts writeFileTool)。
      let isNew = false;
      const before = await readLocalFile(rel, workspaceRoot());
      if (!before.success) isNew = true;

      const result = await writeLocalFile(rel, content, workspaceRoot());
      if (!result.success) {
        throw new Error(result.error || "Failed to write file");
      }
      return { isNew };
    },

    async listFiles(path: string): Promise<{ name: string; type: "file" | "dir" }[]> {
      const rel = toRelativePath(path);
      const result = await listLocalFiles(rel, workspaceRoot());
      if (!result.success) {
        throw new Error(result.error || "Failed to list files");
      }
      return (result.items ?? []).map((item) => ({
        name: item.name,
        type: item.type === "directory" ? ("dir" as const) : ("file" as const),
      }));
    },

    async exec(cmd: string): Promise<ExecResult> {
      const result = await execTool("runCommand", { command: cmd });
      return parseExecResult(result);
    },

    async startProcess(cmd: string, opts?: { cwd?: string }): Promise<{ processId: string }> {
      const result = (await execTool("runInBackground", {
        command: cmd,
        cwd: opts?.cwd,
      })) as { success?: boolean; processId?: number | string; error?: string };
      if (!result?.success || result.processId === undefined) {
        throw new Error(result?.error || "Failed to start process");
      }
      return { processId: String(result.processId) };
    },

    async stopProcess(processId: string): Promise<void> {
      const numericId = Number(processId);
      const result = (await execTool("stopProcess", {
        processId: Number.isNaN(numericId) ? processId : numericId,
      })) as { success?: boolean; error?: string };
      if (result?.success === false) {
        throw new Error(result.error || "Failed to stop process");
      }
    },
  };
}
