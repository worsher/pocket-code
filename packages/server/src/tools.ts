import { tool } from "ai";
import { z } from "zod";
import { readFile, writeFile, readdir, stat, mkdir } from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";
import { join, resolve } from "path";

const execAsync = promisify(exec);

/**
 * Get the workspace root for a session.
 * In production this would be per-user, for MVP we use a shared workspace.
 */
export function getWorkspaceRoot(sessionId: string): string {
  const base = process.env.WORKSPACE_ROOT || "/tmp/pocket-code-workspaces";
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
            env: { ...process.env, HOME: workspace },
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
  };
}
