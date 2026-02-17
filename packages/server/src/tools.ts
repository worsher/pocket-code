import { tool } from "ai";
import { z } from "zod";
import { readFile, writeFile, readdir, stat, mkdir } from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";
import { join, resolve } from "path";
import { homedir } from "os";

const execAsync = promisify(exec);

/**
 * Get the workspace root for a session.
 * Defaults to ~/.pocket-code/workspaces for persistence across restarts.
 */
export function getWorkspaceRoot(sessionId: string): string {
  const base =
    process.env.WORKSPACE_ROOT ||
    resolve(join(homedir(), ".pocket-code", "workspaces"));
  return resolve(join(base, sessionId));
}

/** Ensure a path is within the workspace to prevent directory traversal */
function safePath(workspace: string, relativePath: string): string {
  const full = resolve(workspace, relativePath);
  if (!full.startsWith(workspace)) {
    throw new Error("Path traversal not allowed");
  }
  return full;
}

export function createTools(workspace: string) {
  return {
    readFile: tool({
      description:
        "Read the contents of a file at the given path (relative to workspace root)",
      parameters: z.object({
        path: z.string().describe("Relative file path"),
      }),
      execute: async ({ path }) => {
        const fullPath = safePath(workspace, path);
        try {
          const content = await readFile(fullPath, "utf-8");
          return { success: true, content };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      },
    }),

    writeFile: tool({
      description:
        "Write content to a file at the given path (relative to workspace root). Creates parent directories if needed.",
      parameters: z.object({
        path: z.string().describe("Relative file path"),
        content: z.string().describe("File content to write"),
      }),
      execute: async ({ path, content }) => {
        const fullPath = safePath(workspace, path);
        try {
          const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
          await mkdir(dir, { recursive: true });
          await writeFile(fullPath, content, "utf-8");
          return { success: true, path };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      },
    }),

    listFiles: tool({
      description:
        "List files and directories at the given path (relative to workspace root)",
      parameters: z.object({
        path: z
          .string()
          .default(".")
          .describe("Relative directory path, defaults to workspace root"),
      }),
      execute: async ({ path }) => {
        const fullPath = safePath(workspace, path);
        try {
          const entries = await readdir(fullPath, { withFileTypes: true });
          const items = entries.map((e) => ({
            name: e.name,
            type: e.isDirectory() ? "directory" : "file",
          }));
          return { success: true, items };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      },
    }),

    runCommand: tool({
      description:
        "Execute a shell command in the workspace directory. Use for npm, git, build tools, etc.",
      parameters: z.object({
        command: z.string().describe("The shell command to execute"),
      }),
      execute: async ({ command }) => {
        try {
          const { stdout, stderr } = await execAsync(command, {
            cwd: workspace,
            timeout: 30000,
            maxBuffer: 1024 * 1024,
            env: { ...process.env, HOME: workspace, GIT_TERMINAL_PROMPT: "0" },
          });
          return {
            success: true,
            stdout: stdout.slice(0, 10000),
            stderr: stderr.slice(0, 5000),
          };
        } catch (err: any) {
          return {
            success: false,
            stdout: (err.stdout || "").slice(0, 10000),
            stderr: (err.stderr || "").slice(0, 5000),
            error: err.message,
          };
        }
      },
    }),

    // ── Git tools (CLI wrappers for Termux mode) ──────

    gitClone: tool({
      description: "Clone a git repository into the workspace.",
      parameters: z.object({
        url: z.string().describe("Repository URL (HTTPS)"),
        dir: z.string().optional().describe("Target directory name"),
      }),
      execute: async ({ url, dir }) => {
        try {
          const target = dir || url.split("/").pop()?.replace(/\.git$/, "") || "repo";
          const targetPath = safePath(workspace, target);
          const { stdout, stderr } = await execAsync(
            `git clone --depth 1 ${url} ${targetPath}`,
            { cwd: workspace, timeout: 60000, maxBuffer: 1024 * 1024, env: gitEnv() }
          );
          return { success: true, stdout: stdout.slice(0, 5000), stderr: stderr.slice(0, 2000) };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      },
    }),

    gitStatus: tool({
      description: "Show the working tree status.",
      parameters: z.object({
        path: z.string().optional().describe("Subdirectory within workspace"),
      }),
      execute: async ({ path }) => {
        try {
          const cwd = path ? safePath(workspace, path) : workspace;
          const { stdout } = await execAsync("git status --porcelain", {
            cwd, timeout: 10000, env: gitEnv(),
          });
          const files = stdout.trim().split("\n").filter(Boolean).map((line) => ({
            status: line.slice(0, 2).trim(),
            filepath: line.slice(3),
          }));
          return { success: true, files };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      },
    }),

    gitAdd: tool({
      description: "Stage files for commit.",
      parameters: z.object({
        filepath: z.string().describe("File path to stage, or '.' for all"),
        path: z.string().optional().describe("Repository subdirectory"),
      }),
      execute: async ({ filepath, path }) => {
        try {
          const cwd = path ? safePath(workspace, path) : workspace;
          await execAsync(`git add ${filepath}`, { cwd, timeout: 10000, env: gitEnv() });
          return { success: true };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      },
    }),

    gitCommit: tool({
      description: "Commit staged changes.",
      parameters: z.object({
        message: z.string().describe("Commit message"),
        path: z.string().optional().describe("Repository subdirectory"),
      }),
      execute: async ({ message, path }) => {
        try {
          const cwd = path ? safePath(workspace, path) : workspace;
          const safeMsg = message.replace(/'/g, "'\\''");
          const { stdout } = await execAsync(
            `git commit -m '${safeMsg}'`,
            { cwd, timeout: 10000, env: gitEnv() }
          );
          return { success: true, output: stdout.slice(0, 2000) };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      },
    }),

    gitPush: tool({
      description: "Push commits to remote.",
      parameters: z.object({
        remote: z.string().optional().describe("Remote name (default: origin)"),
        branch: z.string().optional().describe("Branch name"),
        path: z.string().optional().describe("Repository subdirectory"),
      }),
      execute: async ({ remote, branch, path }) => {
        try {
          const cwd = path ? safePath(workspace, path) : workspace;
          const cmd = `git push ${remote || "origin"} ${branch || ""}`.trim();
          const { stdout, stderr } = await execAsync(cmd, {
            cwd, timeout: 30000, env: gitEnv(),
          });
          return { success: true, stdout: stdout.slice(0, 2000), stderr: stderr.slice(0, 2000) };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      },
    }),

    gitPull: tool({
      description: "Pull updates from remote.",
      parameters: z.object({
        remote: z.string().optional().describe("Remote name (default: origin)"),
        branch: z.string().optional().describe("Branch name"),
        path: z.string().optional().describe("Repository subdirectory"),
      }),
      execute: async ({ remote, branch, path }) => {
        try {
          const cwd = path ? safePath(workspace, path) : workspace;
          const cmd = `git pull ${remote || "origin"} ${branch || ""}`.trim();
          const { stdout, stderr } = await execAsync(cmd, {
            cwd, timeout: 30000, env: gitEnv(),
          });
          return { success: true, stdout: stdout.slice(0, 2000), stderr: stderr.slice(0, 2000) };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      },
    }),

    gitLog: tool({
      description: "Show recent commit history.",
      parameters: z.object({
        depth: z.number().optional().describe("Number of commits (default: 10)"),
        path: z.string().optional().describe("Repository subdirectory"),
      }),
      execute: async ({ depth, path }) => {
        try {
          const cwd = path ? safePath(workspace, path) : workspace;
          const n = depth || 10;
          const { stdout } = await execAsync(
            `git log -${n} --format='%h|%s|%an|%ai'`,
            { cwd, timeout: 10000, env: gitEnv() }
          );
          const commits = stdout.trim().split("\n").filter(Boolean).map((line) => {
            const [sha, message, author, date] = line.split("|");
            return { sha, message, author, date };
          });
          return { success: true, commits };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      },
    }),

    gitBranch: tool({
      description: "List or create branches.",
      parameters: z.object({
        name: z.string().optional().describe("New branch name (omit to list)"),
        path: z.string().optional().describe("Repository subdirectory"),
      }),
      execute: async ({ name, path }) => {
        try {
          const cwd = path ? safePath(workspace, path) : workspace;
          if (name) {
            await execAsync(`git branch ${name}`, { cwd, timeout: 10000, env: gitEnv() });
            return { success: true };
          }
          const { stdout } = await execAsync("git branch", { cwd, timeout: 10000, env: gitEnv() });
          const branches = stdout.trim().split("\n").map((b) => b.trim());
          const current = branches.find((b) => b.startsWith("* "))?.slice(2);
          return {
            success: true,
            branches: branches.map((b) => b.replace(/^\* /, "")),
            current,
          };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      },
    }),

    gitCheckout: tool({
      description: "Switch to a branch or commit.",
      parameters: z.object({
        ref: z.string().describe("Branch name or commit SHA"),
        path: z.string().optional().describe("Repository subdirectory"),
      }),
      execute: async ({ ref, path }) => {
        try {
          const cwd = path ? safePath(workspace, path) : workspace;
          await execAsync(`git checkout ${ref}`, { cwd, timeout: 10000, env: gitEnv() });
          return { success: true };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      },
    }),
  };

  /** Git-specific env: HOME=workspace for isolated .gitconfig, no interactive prompt */
  function gitEnv() {
    return { ...process.env, HOME: workspace, GIT_TERMINAL_PROMPT: "0" };
  }
}
