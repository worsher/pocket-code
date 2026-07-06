// NodeBackend: server 侧 RuntimeBackend 实现。执行细节下沉自 tools.ts 的 shellExec/writeFile/listFiles
// 工具实现(host execAsync / docker execInContainer 分支、isolateHome、writeFile isNew+mkdir -p)。
import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import type { RuntimeBackend, ExecResult } from "@pocket-code/agent-core";
import { isDockerEnabled, execInContainer } from "./docker.js";

const execAsync = promisify(exec);

interface NodeExecOpts {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  isolateHome?: boolean;
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
    const containerCwd = opts.cwd ? `/workspace/${opts.cwd}` : "/workspace";
    const env = { ...opts.env };
    if (opts.isolateHome) env.HOME = "/workspace";
    const result = await execInContainer(containerId, command, {
      cwd: containerCwd,
      timeout,
      env,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  }

  // Host mode
  const cwd = opts.cwd ? join(workspace, opts.cwd) : workspace;
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
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      exitCode: typeof err.code === "number" ? err.code : 1,
    };
  }
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
  };
}
