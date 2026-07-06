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
 * C1 修复:runAgentLoop 调用形态里的 workspace 哨兵值。
 *
 * 之前固定传字面量 "/",但 agent-core 的 safePath(workspace, path) 守卫是
 * `full !== ws && !full.startsWith(ws + "/")`。当 workspace="/" 时
 * resolvePosix("/", ".") === "/",于是 `ws + "/"` === "//" —— 任何正常的
 * full(如 "/a/b.ts")既不等于 "/" 也不以 "//" 开头,导致 safePath 对**几乎
 * 所有路径**都抛 "Path traversal not allowed"(readFile/writeFile/editFile/
 * listFiles/searchFiles 全线失效)。改用非 "/" 的哨兵路径段("/workspace")
 * 绕开这个边界条件——resolvePosix("/workspace", ".") === "/workspace",
 * `ws + "/"` === "/workspace/",与 full 的 startsWith 检查正常工作。
 *
 * DeviceBackend 内部已经把 projectId 解析为真实的 workspaceRoot(见
 * workspaceRoot() 闭包),GEEK_WORKSPACE 只是喂给 core safePath 的虚拟根,
 * 与真实文件系统路径无关——core 产出的绝对路径(如 "/workspace/a/b.ts")经
 * toRelativePath 剥掉 "/workspace" 前缀后,才是真正喂给 localFileSystem 的
 * workspaceRoot 相对路径。
 */
export const GEEK_WORKSPACE = "/workspace";

/**
 * 把 core safePath(GEEK_WORKSPACE, path) 产出的绝对路径转换为相对于
 * localFileSystem workspaceRoot 的相对路径。
 *
 * 边界情况:
 * - 恰好等于 "/workspace" → "" (won't be empty caller-side; localFileSystem
 *   把空字符串当作 workspaceRoot 本身)
 * - "/workspace/x" → "x"
 * - 不带 "/workspace" 前缀的路径(理论上不应出现,防御性兜底):退回旧的
 *   "剥前导 /" 逻辑,避免尚未预料到的调用方式直接崩溃。
 */
export function toRelativePath(fullPath: string): string {
  if (fullPath === GEEK_WORKSPACE) return "";
  if (fullPath.startsWith(GEEK_WORKSPACE + "/")) {
    return fullPath.slice(GEEK_WORKSPACE.length + 1);
  }
  // 兜底:未带 GEEK_WORKSPACE 前缀(不应发生,防御性处理)——沿用旧逻辑剥前导 "/"。
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

    // M-obs1 修复:此前完全丢弃 opts,exec 里的 cwd/timeoutMs 调用方设置无效。
    // cwd 与 timeoutMs 透传给 execTool 的 args——"runCommand" 在
    // localFileSystem.executeLocalTool 里本就读 args.cwd(见该文件 "runCommand"
    // case),timeoutMs 目前 executeLocalTool 侧尚未消费(仍固定 60_000ms),
    // 但透传本身对不认识该字段的 execTool 实现无害,为将来接入超时打好接口一致性。
    // env/isolateHome:App 侧 execTool 是单一 RPC 通道(本地 executeLocalTool 或
    // Termux WS),既没有进程级 env 注入的口子,也没有"HOME 指向工作区"的沙箱
    // 概念(不像 server 侧那样管理独立进程环境),因此这两个字段在 App 场景下
    // 无对应的下游消费者,不透传。
    async exec(cmd: string, opts?: { cwd?: string; timeoutMs?: number; env?: Record<string, string>; isolateHome?: boolean }): Promise<ExecResult> {
      const args: Record<string, unknown> = { command: cmd };
      if (opts?.cwd !== undefined) args.cwd = opts.cwd;
      if (opts?.timeoutMs !== undefined) args.timeoutMs = opts.timeoutMs;
      const result = await execTool("runCommand", args);
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
