import { Paths, File, Directory } from "expo-file-system";
import { runLocalCommand } from "pocket-terminal-module";
import type { AppSettings } from "../store/settings";
import {
  gitClone,
  gitStatus,
  gitAdd,
  gitCommit,
  gitPush,
  gitPull,
  gitLog,
  gitBranch,
  gitCheckout,
} from "./gitService";

/**
 * Local file system service for geek mode.
 * Uses expo-file-system (v19 class-based API) to directly access files on the device.
 *
 * Default workspace: Paths.document + "workspace/"
 */

function getWorkspaceDir(workspaceRoot?: string): Directory {
  if (workspaceRoot) {
    return new Directory(workspaceRoot);
  }
  return new Directory(Paths.document, "workspace");
}

/** Ensure workspace directory exists */
function ensureWorkspace(dir: Directory): void {
  if (!dir.exists) {
    dir.create({ idempotent: true });
  }
}

/** Resolve a relative path against the workspace root directory */
function resolveDir(root: Directory, relativePath: string): Directory {
  if (relativePath === "." || relativePath === "") return root;
  // Prevent directory traversal
  const normalized = relativePath.replace(/\.\.\//g, "");
  return new Directory(root, normalized);
}

function resolveFile(root: Directory, relativePath: string): File {
  const normalized = relativePath.replace(/\.\.\//g, "");
  return new File(root, normalized);
}

/** List files and directories at a given path */
export async function listLocalFiles(
  relativePath: string = ".",
  workspaceRoot?: string
): Promise<{ success: boolean; items?: { name: string; type: string }[]; error?: string }> {
  try {
    const root = getWorkspaceDir(workspaceRoot);
    ensureWorkspace(root);

    const targetDir = resolveDir(root, relativePath);
    if (!targetDir.exists) {
      return { success: false, error: "Directory does not exist" };
    }

    const entries = targetDir.list();
    const items: { name: string; type: string }[] = entries.map((entry) => ({
      name: entry.name,
      type: entry instanceof Directory ? "directory" : "file",
    }));

    return { success: true, items };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/** Read file content at a given path */
export async function readLocalFile(
  relativePath: string,
  workspaceRoot?: string
): Promise<{ success: boolean; content?: string; error?: string }> {
  try {
    const root = getWorkspaceDir(workspaceRoot);
    const file = resolveFile(root, relativePath);

    if (!file.exists) {
      return { success: false, error: "File does not exist" };
    }

    const content = await file.text();
    return { success: true, content };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/** Write content to a file at a given path */
export async function writeLocalFile(
  relativePath: string,
  content: string,
  workspaceRoot?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const root = getWorkspaceDir(workspaceRoot);
    ensureWorkspace(root);

    const file = resolveFile(root, relativePath);

    // Ensure parent directory exists
    const parentDir = file.parentDirectory;
    if (!parentDir.exists) {
      parentDir.create({ idempotent: true });
    }

    if (!file.exists) {
      file.create({ intermediates: true, overwrite: true });
    }
    file.write(content);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Execute a tool locally (for geek mode without tool server).
 * Supports: readFile, writeFile, listFiles, and all git tools.
 * Returns null if the tool is not supported locally (e.g. runCommand).
 */
export async function executeLocalTool(
  toolName: string,
  args: Record<string, unknown>,
  settings?: AppSettings
): Promise<unknown | null> {
  switch (toolName) {
    case "listFiles":
      return listLocalFiles((args.path as string) || ".");
    case "readFile":
      return readLocalFile(args.path as string);
    case "writeFile":
      return writeLocalFile(args.path as string, args.content as string);
    // ── Git tools ──
    case "gitClone":
      return gitClone(
        args.url as string,
        args.dir as string | undefined,
        settings!
      );
    case "gitStatus":
      return gitStatus(args.path as string | undefined);
    case "gitAdd":
      return gitAdd(
        args.filepath as string,
        args.path as string | undefined
      );
    case "gitCommit":
      return gitCommit(
        args.message as string,
        args.path as string | undefined
      );
    case "gitPush":
      return gitPush(
        settings!,
        args.path as string | undefined,
        args.remote as string | undefined,
        args.branch as string | undefined
      );
    case "gitPull":
      return gitPull(
        settings!,
        args.path as string | undefined,
        args.remote as string | undefined,
        args.branch as string | undefined
      );
    case "gitLog":
      return gitLog(
        args.path as string | undefined,
        args.depth as number | undefined
      );
    case "gitBranch":
      return gitBranch(
        args.name as string | undefined,
        args.path as string | undefined
      );
    case "gitCheckout":
      return gitCheckout(
        args.ref as string,
        args.path as string | undefined
      );
    case "runCommand": {
      const workspace = getDefaultWorkspace().replace("file://", "");
      const cwd = (args.cwd as string | undefined) || workspace;
      return runLocalCommand(args.command as string, cwd);
    }
    default:
      return null; // Not supported locally
  }
}

/** Get the default workspace path */
export function getDefaultWorkspace(): string {
  const dir = new Directory(Paths.document, "workspace");
  return dir.uri;
}
