// exec 类工具:行为等价迁移自 packages/server/src/tools.ts(runCommand/git 九件套)
// 及 packages/app/src/services/aiClient.ts 的 TOOL_DEFINITIONS(runInBackground/stopProcess schema/description)。
// core 包零依赖:不直接碰 child_process,而是经由 RuntimeBackend.exec/startProcess/stopProcess 抽象。
import type { RuntimeBackend, ToolSchema } from "../types.js";
import type { ToolDef } from "./registry.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** git 命令统一 env:隔离 HOME、禁交互式提示、跳过系统级 git config(对照 tools.ts gitEnv())。 */
const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" };

/**
 * 解析 git 工作目录(同构重写,对照 tools.ts:104-150 resolveGitCwd 语义):
 * - 显式传入 path → 直接返回该 path(调用方负责语义,如 gitClone 除外不调用本函数)。
 * - 否则检查 workspace 根(listFiles(".") 结果含 ".git" 目录条目)→ 根即仓库 → 返回 undefined。
 * - 否则遍历根的一级子目录,对每个目录条目调用 listFiles(<dirName>) 检查是否含 ".git"；
 *   恰好一个匹配 → 返回该子目录名；零个或多个匹配 → 返回 undefined。
 */
export async function resolveGitCwd(backend: RuntimeBackend, path?: string): Promise<string | undefined> {
  if (path) return path;

  const rootEntries = await backend.listFiles(".");
  const hasGitAtRoot = rootEntries.some((e) => e.type === "dir" && e.name === ".git");
  if (hasGitAtRoot) return undefined;

  const dirEntries = rootEntries.filter((e) => e.type === "dir" && e.name !== ".git");
  const gitDirs: string[] = [];
  for (const entry of dirEntries) {
    try {
      const subEntries = await backend.listFiles(entry.name);
      if (subEntries.some((e) => e.type === "dir" && e.name === ".git")) {
        gitDirs.push(entry.name);
      }
    } catch {
      // 子目录不可读,跳过(对照旧版 access 失败即视为非 git 目录)
    }
  }
  if (gitDirs.length === 1) return gitDirs[0];
  return undefined;
}

/** 组装 exec 类工具(runCommand + git 九件套);workspace 供 gitClone 等在根目录操作时使用。 */
export function buildExecTools(workspace: string): ToolDef[] {
  const runCommandSchema: ToolSchema = {
    name: "runCommand",
    description:
      "Execute a shell command in the workspace directory. Use for npm, git, build tools, etc.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to execute" },
      },
      required: ["command"],
    },
  };

  const runCommandTool: ToolDef = {
    schema: runCommandSchema,
    async execute(backend: RuntimeBackend, args: Record<string, unknown>) {
      const command = args.command as string;
      const r = await backend.exec(command, {
        cwd: workspace,
        timeoutMs: 30000,
        env: GIT_ENV,
        isolateHome: true,
      });
      if (r.exitCode === 0) {
        return {
          success: true,
          stdout: r.stdout.slice(0, 5000),
          stderr: r.stderr.slice(0, 2000),
        };
      }
      return {
        success: false,
        error: r.stderr || `exit ${r.exitCode}`,
        stdout: r.stdout.slice(0, 5000),
        stderr: r.stderr.slice(0, 2000),
      };
    },
  };

  const gitCloneSchema: ToolSchema = {
    name: "gitClone",
    description: "Clone a git repository into the workspace.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Repository URL (HTTPS)" },
        dir: { type: "string", description: "Target directory name" },
      },
      required: ["url"],
    },
  };

  const gitCloneTool: ToolDef = {
    schema: gitCloneSchema,
    async execute(backend: RuntimeBackend, args: Record<string, unknown>) {
      const url = args.url as string;
      const dir = args.dir as string | undefined;
      try {
        const target = dir || url.split("/").pop()?.replace(/\.git$/, "") || "repo";
        // gitClone 在 workspace 根跑,不经 resolveGitCwd(尚不存在仓库可解析)
        const r = await backend.exec(`git clone --depth 1 ${url} ${target}`, {
          cwd: workspace,
          timeoutMs: 60000,
          env: GIT_ENV,
          isolateHome: true,
        });
        if (r.exitCode === 0) {
          return { success: true, stdout: r.stdout.slice(0, 5000), stderr: r.stderr.slice(0, 2000) };
        }
        return {
          success: false,
          error: r.stderr || `exit ${r.exitCode}`,
          stderr: r.stderr.slice(0, 2000),
        };
      } catch (err) {
        return { success: false, error: errorMessage(err) };
      }
    },
  };

  const gitStatusSchema: ToolSchema = {
    name: "gitStatus",
    description: "Show the working tree status.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Subdirectory within workspace" },
      },
      required: [],
    },
  };

  const gitStatusTool: ToolDef = {
    schema: gitStatusSchema,
    async execute(backend: RuntimeBackend, args: Record<string, unknown>) {
      const path = args.path as string | undefined;
      try {
        const cwd = await resolveGitCwd(backend, path);
        const r = await backend.exec("git status --porcelain", {
          cwd, timeoutMs: 10000, env: GIT_ENV, isolateHome: true,
        });
        if (r.exitCode !== 0) {
          return { success: false, error: r.stderr || `exit ${r.exitCode}` };
        }
        const files = r.stdout.trim().split("\n").filter(Boolean).map((line) => ({
          status: line.slice(0, 2).trim(),
          filepath: line.slice(3),
        }));
        return { success: true, files };
      } catch (err) {
        return { success: false, error: errorMessage(err) };
      }
    },
  };

  const gitAddSchema: ToolSchema = {
    name: "gitAdd",
    description: "Stage files for commit.",
    parameters: {
      type: "object",
      properties: {
        filepath: { type: "string", description: "File path to stage, or '.' for all" },
        path: { type: "string", description: "Repository subdirectory" },
      },
      required: ["filepath"],
    },
  };

  const gitAddTool: ToolDef = {
    schema: gitAddSchema,
    async execute(backend: RuntimeBackend, args: Record<string, unknown>) {
      const filepath = args.filepath as string;
      const path = args.path as string | undefined;
      try {
        const cwd = await resolveGitCwd(backend, path);
        const r = await backend.exec(`git add ${filepath}`, {
          cwd, timeoutMs: 10000, env: GIT_ENV, isolateHome: true,
        });
        if (r.exitCode !== 0) {
          return { success: false, error: r.stderr || `exit ${r.exitCode}` };
        }
        return { success: true };
      } catch (err) {
        return { success: false, error: errorMessage(err) };
      }
    },
  };

  const gitCommitSchema: ToolSchema = {
    name: "gitCommit",
    description: "Commit staged changes.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "Commit message" },
        path: { type: "string", description: "Repository subdirectory" },
      },
      required: ["message"],
    },
  };

  const gitCommitTool: ToolDef = {
    schema: gitCommitSchema,
    async execute(backend: RuntimeBackend, args: Record<string, unknown>) {
      const message = args.message as string;
      const path = args.path as string | undefined;
      try {
        const cwd = await resolveGitCwd(backend, path);
        const safeMsg = message.replace(/'/g, "'\\''");
        const r = await backend.exec(`git commit -m '${safeMsg}'`, {
          cwd, timeoutMs: 10000, env: GIT_ENV, isolateHome: true,
        });
        if (r.exitCode !== 0) {
          return { success: false, error: r.stderr || `exit ${r.exitCode}` };
        }
        return { success: true, output: r.stdout.slice(0, 2000) };
      } catch (err) {
        return { success: false, error: errorMessage(err) };
      }
    },
  };

  const gitPushSchema: ToolSchema = {
    name: "gitPush",
    description: "Push commits to remote.",
    parameters: {
      type: "object",
      properties: {
        remote: { type: "string", description: "Remote name (default: origin)" },
        branch: { type: "string", description: "Branch name" },
        path: { type: "string", description: "Repository subdirectory" },
      },
      required: [],
    },
  };

  const gitPushTool: ToolDef = {
    schema: gitPushSchema,
    async execute(backend: RuntimeBackend, args: Record<string, unknown>) {
      const remote = args.remote as string | undefined;
      const branch = args.branch as string | undefined;
      const path = args.path as string | undefined;
      try {
        const cwd = await resolveGitCwd(backend, path);
        const cmd = `git push ${remote || "origin"} ${branch || ""}`.trim();
        const r = await backend.exec(cmd, {
          cwd, timeoutMs: 30000, env: GIT_ENV, isolateHome: true,
        });
        if (r.exitCode !== 0) {
          return { success: false, error: r.stderr || `exit ${r.exitCode}` };
        }
        return { success: true, stdout: r.stdout.slice(0, 2000), stderr: r.stderr.slice(0, 2000) };
      } catch (err) {
        return { success: false, error: errorMessage(err) };
      }
    },
  };

  const gitPullSchema: ToolSchema = {
    name: "gitPull",
    description: "Pull updates from remote.",
    parameters: {
      type: "object",
      properties: {
        remote: { type: "string", description: "Remote name (default: origin)" },
        branch: { type: "string", description: "Branch name" },
        path: { type: "string", description: "Repository subdirectory" },
      },
      required: [],
    },
  };

  const gitPullTool: ToolDef = {
    schema: gitPullSchema,
    async execute(backend: RuntimeBackend, args: Record<string, unknown>) {
      const remote = args.remote as string | undefined;
      const branch = args.branch as string | undefined;
      const path = args.path as string | undefined;
      try {
        const cwd = await resolveGitCwd(backend, path);
        const cmd = `git pull ${remote || "origin"} ${branch || ""}`.trim();
        const r = await backend.exec(cmd, {
          cwd, timeoutMs: 30000, env: GIT_ENV, isolateHome: true,
        });
        if (r.exitCode !== 0) {
          return { success: false, error: r.stderr || `exit ${r.exitCode}` };
        }
        return { success: true, stdout: r.stdout.slice(0, 2000), stderr: r.stderr.slice(0, 2000) };
      } catch (err) {
        return { success: false, error: errorMessage(err) };
      }
    },
  };

  const gitLogSchema: ToolSchema = {
    name: "gitLog",
    description: "Show recent commit history.",
    parameters: {
      type: "object",
      properties: {
        depth: { type: "number", description: "Number of commits (default: 10)" },
        path: { type: "string", description: "Repository subdirectory" },
      },
      required: [],
    },
  };

  const gitLogTool: ToolDef = {
    schema: gitLogSchema,
    async execute(backend: RuntimeBackend, args: Record<string, unknown>) {
      const depth = args.depth as number | undefined;
      const path = args.path as string | undefined;
      try {
        const cwd = await resolveGitCwd(backend, path);
        const n = depth || 10;
        const r = await backend.exec(`git log -${n} --format='%h|%s|%an|%ai'`, {
          cwd, timeoutMs: 10000, env: GIT_ENV, isolateHome: true,
        });
        if (r.exitCode !== 0) {
          return { success: false, error: r.stderr || `exit ${r.exitCode}` };
        }
        const commits = r.stdout.trim().split("\n").filter(Boolean).map((line) => {
          const [sha, message, author, date] = line.split("|");
          return { sha, message, author, date };
        });
        return { success: true, commits };
      } catch (err) {
        return { success: false, error: errorMessage(err) };
      }
    },
  };

  const gitBranchSchema: ToolSchema = {
    name: "gitBranch",
    description: "List or create branches.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "New branch name (omit to list)" },
        path: { type: "string", description: "Repository subdirectory" },
      },
      required: [],
    },
  };

  const gitBranchTool: ToolDef = {
    schema: gitBranchSchema,
    async execute(backend: RuntimeBackend, args: Record<string, unknown>) {
      const name = args.name as string | undefined;
      const path = args.path as string | undefined;
      try {
        const cwd = await resolveGitCwd(backend, path);
        if (name) {
          const r = await backend.exec(`git branch ${name}`, {
            cwd, timeoutMs: 10000, env: GIT_ENV, isolateHome: true,
          });
          if (r.exitCode !== 0) {
            return { success: false, error: r.stderr || `exit ${r.exitCode}` };
          }
          return { success: true };
        }
        const r = await backend.exec("git branch", {
          cwd, timeoutMs: 10000, env: GIT_ENV, isolateHome: true,
        });
        if (r.exitCode !== 0) {
          return { success: false, error: r.stderr || `exit ${r.exitCode}` };
        }
        const branches = r.stdout.trim().split("\n").map((b) => b.trim());
        const current = branches.find((b) => b.startsWith("* "))?.slice(2);
        return {
          success: true,
          branches: branches.map((b) => b.replace(/^\* /, "")),
          current,
        };
      } catch (err) {
        return { success: false, error: errorMessage(err) };
      }
    },
  };

  const gitCheckoutSchema: ToolSchema = {
    name: "gitCheckout",
    description: "Switch to a branch or commit.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Branch name or commit SHA" },
        path: { type: "string", description: "Repository subdirectory" },
      },
      required: ["ref"],
    },
  };

  const gitCheckoutTool: ToolDef = {
    schema: gitCheckoutSchema,
    async execute(backend: RuntimeBackend, args: Record<string, unknown>) {
      const ref = args.ref as string;
      const path = args.path as string | undefined;
      try {
        const cwd = await resolveGitCwd(backend, path);
        const r = await backend.exec(`git checkout ${ref}`, {
          cwd, timeoutMs: 10000, env: GIT_ENV, isolateHome: true,
        });
        if (r.exitCode !== 0) {
          return { success: false, error: r.stderr || `exit ${r.exitCode}` };
        }
        return { success: true };
      } catch (err) {
        return { success: false, error: errorMessage(err) };
      }
    },
  };

  return [
    runCommandTool,
    gitCloneTool,
    gitStatusTool,
    gitAddTool,
    gitCommitTool,
    gitPushTool,
    gitPullTool,
    gitLogTool,
    gitBranchTool,
    gitCheckoutTool,
  ];
}

/** 能力门控的进程工具:仅当 backend 提供 startProcess/stopProcess 时才注册(schema/description 迁自 aiClient TOOL_DEFINITIONS)。 */
export function buildProcessTools(backend: RuntimeBackend): ToolDef[] {
  if (!backend.startProcess || !backend.stopProcess) return [];

  const runInBackgroundSchema: ToolSchema = {
    name: "runInBackground",
    description:
      "Start a long-running process in the background (dev server, watcher, etc.) that does NOT exit on its own. Use this for: npm run dev, npm start, vite, python -m http.server, nodemon, webpack --watch, etc. The process starts immediately and streams output in real-time. Returns a processId that can be used with stopProcess. The dev server will be accessible at http://localhost:PORT from the device browser.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The long-running shell command to start (e.g. 'npm run dev')." },
        cwd: { type: "string", description: "Working directory relative to workspace root (e.g. 'vite-example'). Defaults to workspace root." },
      },
      required: ["command"],
    },
  };

  const runInBackgroundTool: ToolDef = {
    schema: runInBackgroundSchema,
    async execute(be: RuntimeBackend, args: Record<string, unknown>) {
      const command = args.command as string;
      const cwd = args.cwd as string | undefined;
      try {
        const { processId } = await be.startProcess!(command, { cwd });
        return { success: true, processId };
      } catch (err) {
        return { success: false, error: errorMessage(err) };
      }
    },
  };

  const stopProcessSchema: ToolSchema = {
    name: "stopProcess",
    description: "Stop a running background process started with runInBackground.",
    parameters: {
      type: "object",
      properties: {
        processId: { type: "number", description: "The processId returned by runInBackground." },
      },
      required: ["processId"],
    },
  };

  const stopProcessTool: ToolDef = {
    schema: stopProcessSchema,
    async execute(be: RuntimeBackend, args: Record<string, unknown>) {
      const processId = args.processId as string;
      try {
        await be.stopProcess!(processId);
        return { success: true };
      } catch (err) {
        return { success: false, error: errorMessage(err) };
      }
    },
  };

  return [runInBackgroundTool, stopProcessTool];
}
