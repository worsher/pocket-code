// NodeBackend: server 侧 RuntimeBackend 实现。执行细节下沉自 tools.ts 的 shellExec/writeFile/listFiles
// 工具实现(host execAsync / docker execInContainer 分支、isolateHome、writeFile isNew+mkdir -p)。
import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, isAbsolute, relative } from "node:path";
import type { RuntimeBackend, ExecResult } from "@pocket-code/agent-core";
import { isDockerEnabled, execInContainer } from "./docker.js";
import { startManaged, stopManaged } from "./processRegistry.js";

const execAsync = promisify(exec);

interface NodeExecOpts {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  isolateHome?: boolean;
}

/**
 * 解析 host 侧实际 cwd:opts.cwd 可能是(1)undefined(2)workspace 内相对路径(如 "sub"，来自 resolveGitCwd)
 * (3)绝对路径(如 execTools.ts runCommand/gitClone 直传 workspace 本身)。
 * 绝对路径须直接使用，不能再 join(workspace, absPath) 否则拼出 "/ws/ws" 之类不存在目录(C3)。
 */
function resolveHostCwd(workspace: string, cwd?: string): string {
  if (!cwd) return workspace;
  return isAbsolute(cwd) ? cwd : join(workspace, cwd);
}

/**
 * 解析容器内 cwd:同样需要兼容绝对路径入参。
 * - 未传 → "/workspace"
 * - 绝对路径且等于 workspace → "/workspace"
 * - 绝对路径且是 workspace 子路径 → "/workspace/<相对部分>"
 * - 其他绝对路径(已是容器内路径,如调用方直接传 "/workspace/xxx") → 原样使用
 * - 相对路径 → "/workspace/<相对路径>"
 */
function resolveContainerCwd(workspace: string, cwd?: string): string {
  if (!cwd) return "/workspace";
  if (isAbsolute(cwd)) {
    if (cwd === workspace) return "/workspace";
    const rel = relative(workspace, cwd);
    if (!rel.startsWith("..") && !isAbsolute(rel)) {
      return join("/workspace", rel);
    }
    // 与 workspace 无从属关系的绝对路径:视为已是容器内路径，原样使用
    return cwd;
  }
  return join("/workspace", cwd);
}

/** 归一非零退出:host execAsync 抛异常需从 err.code/err.stdout/err.stderr 取值;docker execInContainer 本就返回 exitCode。 */
async function shellExec(
  command: string,
  workspace: string,
  containerId: string | undefined,
  opts: NodeExecOpts
): Promise<ExecResult> {
  const timeout = opts.timeoutMs ?? 30000;

  if (containerId && isDockerEnabled()) {
    const containerCwd = resolveContainerCwd(workspace, opts.cwd);
    const env = { ...opts.env };
    if (opts.isolateHome) env.HOME = "/workspace";
    try {
      const result = await execInContainer(containerId, command, {
        cwd: containerCwd,
        timeout,
        env,
      });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    } catch (err: any) {
      // C2: execInContainer 在 timeout/流错误/exec 启动失败时会 reject，
      // 但 RuntimeBackend.exec 契约是"不抛出，归一为 ExecResult"。
      return {
        stdout: "",
        stderr: errMessage(err),
        exitCode: 126,
      };
    }
  }

  // Host mode
  const cwd = resolveHostCwd(workspace, opts.cwd);
  const env: Record<string, string> = { ...(process.env as Record<string, string>), ...opts.env };
  if (opts.isolateHome) env.HOME = workspace;

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout,
      maxBuffer: 1024 * 1024,
      env,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: any) {
    // C1: 区分三种失败形态，不再笼统兜底 exitCode 1。
    if (err && err.killed && err.signal) {
      // 超时(execAsync 内部用 signal 杀掉进程) 或被外部信号杀掉
      return {
        stdout: err.stdout ?? "",
        stderr: `${err.stderr ?? ""}\n[killed by ${err.signal} (timeout ${timeout}ms?)]`,
        exitCode: 124,
      };
    }
    if (err && err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      return {
        stdout: err.stdout ?? "",
        stderr: `${err.stderr ?? ""}\n[output truncated: maxBuffer exceeded]`,
        exitCode: 125,
      };
    }
    if (err && typeof err.code === "number") {
      return {
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? "",
        exitCode: err.code,
      };
    }
    // 其余情况(如 cwd 不存在的 ENOENT，err.code 是字符串 "ENOENT"):
    // 命令根本没跑起来，没有可用的 stdout/stderr，只有 err.message 可诊断。
    return {
      stdout: "",
      stderr: errMessage(err),
      exitCode: 127,
    };
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createNodeBackend(workspace: string, containerId?: string): RuntimeBackend {
  return {
    async readFile(path: string): Promise<string> {
      return readFile(path, "utf-8");
    },

    async writeFile(path: string, content: string): Promise<{ isNew: boolean }> {
      let isNew = false;
      try {
        await stat(path);
      } catch {
        isNew = true;
      }
      const dir = dirname(path);
      await mkdir(dir, { recursive: true });
      await writeFile(path, content, "utf-8");
      return { isNew };
    },

    async listFiles(path: string): Promise<{ name: string; type: "file" | "dir" }[]> {
      const entries = await readdir(path, { withFileTypes: true });
      return entries.map((e) => ({
        name: e.name,
        type: e.isDirectory() ? "dir" : "file",
      }));
    },

    async exec(cmd: string, opts?: NodeExecOpts): Promise<ExecResult> {
      return shellExec(cmd, workspace, containerId, opts ?? {});
    },

    async startProcess(cmd: string, opts?: { cwd?: string }) {
      const ws = resolveHostCwd(workspace, opts?.cwd);
      return startManaged(ws, cmd, { containerId });
    },
    async stopProcess(processId: string) {
      await stopManaged(processId);
    },
  };
}
