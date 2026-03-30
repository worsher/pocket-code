import { tool } from "ai";
import { z } from "zod";
import { readFile, writeFile, readdir, stat, mkdir, access } from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";
import { join, resolve } from "path";
import { homedir } from "os";
import { isDockerEnabled, execInContainer } from "./docker.js";

const execAsync = promisify(exec);

/**
 * Get the workspace root for a session or project.
 * - With projectId: ~/.pocket-code/projects/{projectId}/workspace (shared across sessions)
 * - Without projectId: ~/.pocket-code/workspaces/{sessionId} (legacy, per-session)
 */
export function getWorkspaceRoot(sessionId: string, projectId?: string): string {
  if (projectId) {
    const base =
      process.env.PROJECTS_ROOT ||
      resolve(join(homedir(), ".pocket-code", "projects"));
    return resolve(join(base, projectId, "workspace"));
  }
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

// ── Shell exec abstraction ──────────────────────────────

interface ExecOptions {
  workspace: string;
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
  containerId?: string;
}

/**
 * Execute a shell command. If containerId is provided and Docker is enabled,
 * runs inside the container. Otherwise runs on the host.
 */
async function shellExec(
  command: string,
  opts: ExecOptions
): Promise<{ stdout: string; stderr: string }> {
  if (opts.containerId && isDockerEnabled()) {
    // Docker mode: relative cwd inside container
    const containerCwd = opts.cwd
      ? `/workspace/${opts.cwd}`
      : "/workspace";
    const result = await execInContainer(opts.containerId, command, {
      cwd: containerCwd,
      timeout: opts.timeout || 30000,
      env: opts.env,
    });
    if (result.exitCode !== 0) {
      throw Object.assign(
        new Error(result.stderr || `Command failed with exit code ${result.exitCode}`),
        { stdout: result.stdout, stderr: result.stderr }
      );
    }
    return { stdout: result.stdout, stderr: result.stderr };
  }

  // Host mode (dev / no Docker)
  const { stdout, stderr } = await execAsync(command, {
    cwd: opts.cwd ? safePath(opts.workspace, opts.cwd) : opts.workspace,
    timeout: opts.timeout || 30000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, ...opts.env },
  });
  return { stdout, stderr };
}

// ── Tool factory ────────────────────────────────────────

export function createTools(workspace: string, containerId?: string) {
  /** Git env: isolated HOME, no interactive prompt, skip system config */
  function gitEnv(): Record<string, string> {
    const common = { GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" };
    if (containerId && isDockerEnabled()) {
      return { HOME: "/workspace", ...common };
    }
    return { ...process.env as Record<string, string>, HOME: workspace, ...common };
  }

  /**
   * Resolve the git working directory.
   * When no explicit `path` is given, check if workspace root is a git repo;
   * if not, look for a single subdirectory that contains `.git`.
   * This handles the common case where `gitClone` created a repo in a subdirectory.
   */
  async function resolveGitCwd(path?: string): Promise<string | undefined> {
    if (path) return path;

    // Docker mode: check inside container
    if (containerId && isDockerEnabled()) {
      try {
        await shellExec("test -d /workspace/.git", { workspace, containerId, timeout: 5000 });
        return undefined; // workspace root is a git repo
      } catch {
        // Not a git repo at root — look for single git subdirectory
        try {
          const { stdout } = await shellExec(
            "ls -d /workspace/*/.git 2>/dev/null | head -2",
            { workspace, containerId, timeout: 5000 }
          );
          const matches = stdout.trim().split("\n").filter(Boolean);
          if (matches.length === 1) {
            // Extract subdirectory name: /workspace/repo-name/.git → repo-name
            const match = matches[0].replace(/\/\.git$/, "").replace(/^\/workspace\//, "");
            return match;
          }
        } catch { /* no git dirs found */ }
      }
      return undefined;
    }

    // Host mode: check filesystem directly
    try {
      await access(join(workspace, ".git"));
      return undefined; // workspace root is a git repo
    } catch {
      // Not a git repo at root — look for single git subdirectory
      try {
        const entries = await readdir(workspace, { withFileTypes: true });
        const gitDirs: string[] = [];
        for (const entry of entries) {
          if (entry.isDirectory()) {
            try {
              await access(join(workspace, entry.name, ".git"));
              gitDirs.push(entry.name);
            } catch { /* not a git repo */ }
          }
        }
        if (gitDirs.length === 1) {
          return gitDirs[0];
        }
      } catch { /* readdir failed */ }
    }
    return undefined;
  }

  return {
    readFile: tool({
      description:
        "Read the contents of a file at the given path (relative to workspace root)",
      parameters: z.object({
        path: z.string().describe("Relative file path"),
      }),
      execute: async ({ path }) => {
        try {
          if (containerId && isDockerEnabled()) {
            const containerPath = `/workspace/${path}`;
            const { stdout } = await shellExec(`cat ${JSON.stringify(containerPath)}`, {
              workspace, containerId, timeout: 10000,
            });
            return { success: true, content: stdout };
          }
          const fullPath = safePath(workspace, path);
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
        try {
          if (containerId && isDockerEnabled()) {
            const containerPath = `/workspace/${path}`;
            const containerDir = containerPath.substring(0, containerPath.lastIndexOf("/"));

            // Read old content for diff display
            let oldContent: string | null = null;
            try {
              const { stdout } = await shellExec(`cat ${JSON.stringify(containerPath)}`, {
                workspace, containerId, timeout: 10000,
              });
              oldContent = stdout;
            } catch {
              // File doesn't exist yet
            }

            // Create parent directory and write via base64 to handle special characters
            const b64 = Buffer.from(content, "utf-8").toString("base64");
            await shellExec(
              `mkdir -p ${JSON.stringify(containerDir)} && echo ${JSON.stringify(b64)} | base64 -d > ${JSON.stringify(containerPath)}`,
              { workspace, containerId, timeout: 10000 }
            );

            const isNew = oldContent === null;
            return {
              success: true,
              path,
              isNew,
              ...(isNew ? {} : { oldContent }),
              newContent: content,
            };
          }

          const fullPath = safePath(workspace, path);
          // Read old content for diff display
          let oldContent: string | null = null;
          try {
            oldContent = await readFile(fullPath, "utf-8");
          } catch {
            // File doesn't exist yet
          }

          const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
          await mkdir(dir, { recursive: true });
          await writeFile(fullPath, content, "utf-8");

          const isNew = oldContent === null;
          return {
            success: true,
            path,
            isNew,
            ...(isNew ? {} : { oldContent }),
            newContent: content,
          };
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
        try {
          if (containerId && isDockerEnabled()) {
            const containerPath = path === "." ? "/workspace" : `/workspace/${path}`;
            // Use ls -1F: -1 one per line, -F append / to directories
            const { stdout } = await shellExec(`ls -1F ${JSON.stringify(containerPath)}`, {
              workspace, containerId, timeout: 10000,
            });
            const items = stdout.trim().split("\n").filter(Boolean).map((entry) => {
              const isDir = entry.endsWith("/");
              return {
                name: isDir ? entry.slice(0, -1) : entry,
                type: isDir ? "directory" : "file",
              };
            });
            return { success: true, items };
          }

          const fullPath = safePath(workspace, path);
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
          const { stdout, stderr } = await shellExec(command, {
            workspace,
            containerId,
            timeout: 30000,
            env: gitEnv(),
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

    // ── Git tools (CLI wrappers) ──────────────────────

    gitClone: tool({
      description: "Clone a git repository into the workspace.",
      parameters: z.object({
        url: z.string().describe("Repository URL (HTTPS)"),
        dir: z.string().optional().describe("Target directory name"),
      }),
      execute: async ({ url, dir }) => {
        try {
          const target = dir || url.split("/").pop()?.replace(/\.git$/, "") || "repo";
          if (containerId && isDockerEnabled()) {
            const { stdout, stderr } = await shellExec(
              `git clone --depth 1 ${url} /workspace/${target}`,
              { workspace, containerId, timeout: 60000, env: gitEnv() }
            );
            return { success: true, stdout: stdout.slice(0, 5000), stderr: stderr.slice(0, 2000) };
          }
          const targetPath = safePath(workspace, target);
          const { stdout, stderr } = await shellExec(
            `git clone --depth 1 ${url} ${targetPath}`,
            { workspace, timeout: 60000, env: gitEnv() }
          );
          return { success: true, stdout: stdout.slice(0, 5000), stderr: stderr.slice(0, 2000) };
        } catch (err: any) {
          return {
            success: false,
            error: err.message,
            stderr: (err.stderr || "").slice(0, 2000),
          };
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
          const cwd = await resolveGitCwd(path);
          const { stdout } = await shellExec("git status --porcelain", {
            workspace, containerId, cwd, timeout: 10000, env: gitEnv(),
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
          const cwd = await resolveGitCwd(path);
          await shellExec(`git add ${filepath}`, {
            workspace, containerId, cwd, timeout: 10000, env: gitEnv(),
          });
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
          const cwd = await resolveGitCwd(path);
          const safeMsg = message.replace(/'/g, "'\\''");
          const { stdout } = await shellExec(
            `git commit -m '${safeMsg}'`,
            { workspace, containerId, cwd, timeout: 10000, env: gitEnv() }
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
          const cwd = await resolveGitCwd(path);
          const cmd = `git push ${remote || "origin"} ${branch || ""}`.trim();
          const { stdout, stderr } = await shellExec(cmd, {
            workspace, containerId, cwd, timeout: 30000, env: gitEnv(),
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
          const cwd = await resolveGitCwd(path);
          const cmd = `git pull ${remote || "origin"} ${branch || ""}`.trim();
          const { stdout, stderr } = await shellExec(cmd, {
            workspace, containerId, cwd, timeout: 30000, env: gitEnv(),
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
          const cwd = await resolveGitCwd(path);
          const n = depth || 10;
          const { stdout } = await shellExec(
            `git log -${n} --format='%h|%s|%an|%ai'`,
            { workspace, containerId, cwd, timeout: 10000, env: gitEnv() }
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
          const cwd = await resolveGitCwd(path);
          if (name) {
            await shellExec(`git branch ${name}`, {
              workspace, containerId, cwd, timeout: 10000, env: gitEnv(),
            });
            return { success: true };
          }
          const { stdout } = await shellExec("git branch", {
            workspace, containerId, cwd, timeout: 10000, env: gitEnv(),
          });
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
          const cwd = await resolveGitCwd(path);
          await shellExec(`git checkout ${ref}`, {
            workspace, containerId, cwd, timeout: 10000, env: gitEnv(),
          });
          return { success: true };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      },
    }),

    // ── Search & Edit tools ──────────────────────────────

    searchFiles: tool({
      description:
        "Search for a text pattern across files in the workspace using grep. Returns matching lines with file paths and line numbers. Use this to find code, functions, imports, or any text patterns.",
      parameters: z.object({
        pattern: z.string().describe("Search pattern (text or regex)"),
        path: z
          .string()
          .default(".")
          .describe("Directory to search in (relative to workspace root)"),
        include: z
          .string()
          .optional()
          .describe("File glob pattern to include, e.g. '*.ts' or '*.py'"),
        ignoreCase: z
          .boolean()
          .default(false)
          .describe("Whether to ignore case"),
        isRegex: z
          .boolean()
          .default(false)
          .describe("Whether the pattern is a regex"),
      }),
      execute: async ({ pattern, path, include, ignoreCase, isRegex }) => {
        try {
          // Build grep command
          const flags = [
            "-rn", // recursive + line numbers
            "--color=never",
            ignoreCase ? "-i" : "",
            isRegex ? "-E" : "-F", // -F for fixed string, -E for extended regex
          ]
            .filter(Boolean)
            .join(" ");

          const includeFlag = include ? `--include='${include}'` : "";
          const safePattern = JSON.stringify(pattern);

          const searchPath =
            containerId && isDockerEnabled()
              ? path === "." ? "/workspace" : `/workspace/${path}`
              : path === "." ? workspace : safePath(workspace, path);

          const cmd = `grep ${flags} ${includeFlag} ${safePattern} ${JSON.stringify(searchPath)} | head -50`;

          const { stdout } = await shellExec(cmd, {
            workspace,
            containerId,
            timeout: 15000,
          });

          const matches = stdout
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => {
              // Format: filepath:lineNumber:content
              const firstColon = line.indexOf(":");
              const secondColon = line.indexOf(":", firstColon + 1);
              if (firstColon === -1 || secondColon === -1) {
                return { file: "", line: 0, content: line };
              }
              let file = line.slice(0, firstColon);
              // Strip workspace prefix for cleaner output
              const wsPrefix = containerId && isDockerEnabled() ? "/workspace/" : workspace + "/";
              if (file.startsWith(wsPrefix)) {
                file = file.slice(wsPrefix.length);
              }
              return {
                file,
                line: parseInt(line.slice(firstColon + 1, secondColon), 10) || 0,
                content: line.slice(secondColon + 1).trim(),
              };
            });

          return {
            success: true,
            matchCount: matches.length,
            matches,
            truncated: matches.length >= 50,
          };
        } catch (err: any) {
          // grep returns exit code 1 when no matches found
          if (err.message?.includes("exit code 1") || err.stdout === "") {
            return { success: true, matchCount: 0, matches: [], truncated: false };
          }
          return { success: false, error: err.message };
        }
      },
    }),

    editFile: tool({
      description:
        "Edit a file by replacing a specific text string with new content. More precise than writeFile for modifying existing files — only the matched portion is changed. The oldText must match exactly (including whitespace and indentation).",
      parameters: z.object({
        path: z.string().describe("Relative file path"),
        oldText: z
          .string()
          .describe(
            "The exact text to find and replace. Must match the file content exactly."
          ),
        newText: z.string().describe("The replacement text"),
      }),
      execute: async ({ path, oldText, newText }) => {
        try {
          // Read current content
          let content: string;
          if (containerId && isDockerEnabled()) {
            const containerPath = `/workspace/${path}`;
            const { stdout } = await shellExec(
              `cat ${JSON.stringify(containerPath)}`,
              { workspace, containerId, timeout: 10000 }
            );
            content = stdout;
          } else {
            const fullPath = safePath(workspace, path);
            content = await readFile(fullPath, "utf-8");
          }

          // Verify the old text exists
          const index = content.indexOf(oldText);
          if (index === -1) {
            return {
              success: false,
              error:
                "oldText not found in the file. Make sure it matches exactly including whitespace.",
            };
          }

          // Check for multiple occurrences
          const secondIndex = content.indexOf(oldText, index + oldText.length);
          if (secondIndex !== -1) {
            return {
              success: false,
              error:
                "oldText found multiple times in the file. Provide a more specific (longer) oldText to match uniquely.",
            };
          }

          // Apply the edit
          const newContent = content.slice(0, index) + newText + content.slice(index + oldText.length);

          // Write back
          if (containerId && isDockerEnabled()) {
            const containerPath = `/workspace/${path}`;
            const b64 = Buffer.from(newContent, "utf-8").toString("base64");
            await shellExec(
              `echo ${JSON.stringify(b64)} | base64 -d > ${JSON.stringify(containerPath)}`,
              { workspace, containerId, timeout: 10000 }
            );
          } else {
            const fullPath = safePath(workspace, path);
            await writeFile(fullPath, newContent, "utf-8");
          }

          return {
            success: true,
            path,
            oldContent: content,
            newContent,
          };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      },
    }),
  };
}
