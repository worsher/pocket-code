import { File, Directory } from "expo-file-system";
import * as LegacyFS from "expo-file-system/legacy";
import { requireNativeModule } from "expo-modules-core";
import { normalizeWorkspaceRelativePath } from "@pocket-code/workspace-core";
import type { WorkspaceHandle } from "@pocket-code/workspace-core";
import { exec as localExec, startBackgroundExec } from "./localExecutor";
import { killProcess } from "./processManager";
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

export type MobileWorkspaceTarget =
  | string
  | (Pick<WorkspaceHandle, "worktreeRoot"> &
      Partial<Pick<WorkspaceHandle, "capabilities" | "generation">>);

function assertWorkspaceCapability(
  target: MobileWorkspaceTarget,
  capability: keyof WorkspaceHandle["capabilities"]
): void {
  if (typeof target !== "string" && target.capabilities?.[capability] === false) {
    throw new Error(`Workspace replica does not have ${capability} capability in this writer mode`);
  }
}

export function getMobileWorkspaceRoot(target: MobileWorkspaceTarget): string {
  if (typeof target === "string") return target;
  return target.worktreeRoot;
}

function getWorkspaceDir(target: MobileWorkspaceTarget): Directory {
  return new Directory(getMobileWorkspaceRoot(target));
}

/** Ensure workspace directory exists */
function ensureWorkspace(dir: Directory): void {
  if (!dir.exists) {
    dir.create({ idempotent: true });
  }
}

function nativePathFromFileUri(uri: string): string {
  if (!uri.startsWith("file://")) {
    throw new Error("Workspace file access requires an app-private file URI");
  }
  return decodeURIComponent(uri.slice("file://".length)).replace(/\/$/, "");
}

async function resolveCanonicalWorkspaceUri(
  root: Directory,
  relativePath: string,
  allowMissing: boolean
): Promise<string> {
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  const module = requireNativeModule("PocketTerminalModule");
  const canonicalPath = await module.resolveWorkspacePath(
    nativePathFromFileUri(root.uri),
    normalized === "." ? "" : normalized,
    allowMissing
  );
  if (typeof canonicalPath !== "string" || !canonicalPath.startsWith("/")) {
    throw new Error("Native workspace path validation returned an invalid path");
  }
  return `file://${canonicalPath}`;
}

/** Resolve a relative path against the workspace root directory. */
async function resolveDir(root: Directory, relativePath: string): Promise<Directory> {
  return new Directory(await resolveCanonicalWorkspaceUri(root, relativePath, false));
}

async function resolveFile(
  root: Directory,
  relativePath: string,
  allowMissing: boolean
): Promise<File> {
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  if (normalized === ".") throw new Error("A file path is required");
  return new File(await resolveCanonicalWorkspaceUri(root, normalized, allowMissing));
}

/** List files and directories at a given path */
export async function listLocalFiles(
  relativePath: string,
  workspaceTarget: MobileWorkspaceTarget
): Promise<{ success: boolean; items?: { name: string; type: string }[]; error?: string }> {
  try {
    assertWorkspaceCapability(workspaceTarget, "read");
    const root = getWorkspaceDir(workspaceTarget);
    ensureWorkspace(root);

    const targetDir = await resolveDir(root, relativePath);
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
  workspaceTarget: MobileWorkspaceTarget
): Promise<{ success: boolean; content?: string; error?: string }> {
  try {
    assertWorkspaceCapability(workspaceTarget, "read");
    const root = getWorkspaceDir(workspaceTarget);
    const file = await resolveFile(root, relativePath, false);

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
  workspaceTarget: MobileWorkspaceTarget
): Promise<{ success: boolean; error?: string }> {
  try {
    assertWorkspaceCapability(workspaceTarget, "write");
    const root = getWorkspaceDir(workspaceTarget);
    ensureWorkspace(root);

    const file = await resolveFile(root, relativePath, true);

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
 * Write base64-encoded content to a file, decoding to raw bytes.
 * 二进制安全(图片等)与文本均正确——直接写解码后的字节,不经 utf-8。
 * 用于代码同步(sync-file-content 是 base64)。
 */
export async function writeLocalFileBase64(
  relativePath: string,
  base64: string,
  workspaceTarget: MobileWorkspaceTarget
): Promise<{ success: boolean; error?: string }> {
  try {
    assertWorkspaceCapability(workspaceTarget, "write");
    const root = getWorkspaceDir(workspaceTarget);
    ensureWorkspace(root);

    const file = await resolveFile(root, relativePath, true);
    const parentDir = file.parentDirectory;
    if (!parentDir.exists) {
      parentDir.create({ idempotent: true });
    }
    await LegacyFS.writeAsStringAsync(file.uri, base64, {
      encoding: LegacyFS.EncodingType.Base64,
    });
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function readLocalFileBase64(
  relativePath: string,
  workspaceTarget: MobileWorkspaceTarget
): Promise<{ success: boolean; content?: string; error?: string }> {
  try {
    assertWorkspaceCapability(workspaceTarget, "read");
    const root = getWorkspaceDir(workspaceTarget);
    const file = await resolveFile(root, relativePath, false);
    if (!file.exists) return { success: false, error: "File does not exist" };
    return { success: true, content: await file.base64() };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/** Delete a file at a given path (idempotent — missing file is a no-op). */
export async function deleteLocalFile(
  relativePath: string,
  workspaceTarget: MobileWorkspaceTarget
): Promise<{ success: boolean; error?: string }> {
  try {
    assertWorkspaceCapability(workspaceTarget, "write");
    const root = getWorkspaceDir(workspaceTarget);
    const file = await resolveFile(root, relativePath, true);
    if (file.exists) {
      file.delete();
    }
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
  settings: AppSettings | undefined,
  workspaceTarget: MobileWorkspaceTarget,
  credentialProfileId?: string
): Promise<unknown | null> {
  const workspaceRoot = getMobileWorkspaceRoot(workspaceTarget);
  switch (toolName) {
    case "listFiles":
      return listLocalFiles((args.path as string) || ".", workspaceTarget);
    case "readFile":
      return readLocalFile(args.path as string, workspaceTarget);
    case "writeFile":
      return writeLocalFile(args.path as string, args.content as string, workspaceTarget);
    // ── Git tools ──
    case "gitClone":
      assertWorkspaceCapability(workspaceTarget, "write");
      return gitClone(
        args.url as string,
        args.dir as string | undefined,
        settings!,
        workspaceRoot,
        credentialProfileId
      );
    case "gitStatus":
      assertWorkspaceCapability(workspaceTarget, "read");
      return gitStatus(args.path as string | undefined, workspaceRoot);
    case "gitAdd":
      assertWorkspaceCapability(workspaceTarget, "write");
      return gitAdd(args.filepath as string, args.path as string | undefined, workspaceRoot);
    case "gitCommit":
      assertWorkspaceCapability(workspaceTarget, "write");
      return gitCommit(args.message as string, args.path as string | undefined, workspaceRoot);
    case "gitPush":
      assertWorkspaceCapability(workspaceTarget, "write");
      return gitPush(
        settings!,
        args.path as string | undefined,
        args.remote as string | undefined,
        args.branch as string | undefined,
        workspaceRoot,
        credentialProfileId
      );
    case "gitPull":
      assertWorkspaceCapability(workspaceTarget, "write");
      return gitPull(
        settings!,
        args.path as string | undefined,
        args.remote as string | undefined,
        args.branch as string | undefined,
        workspaceRoot,
        credentialProfileId
      );
    case "gitLog":
      assertWorkspaceCapability(workspaceTarget, "read");
      return gitLog(
        args.path as string | undefined,
        args.depth as number | undefined,
        workspaceRoot
      );
    case "gitBranch":
      assertWorkspaceCapability(workspaceTarget, args.name ? "write" : "read");
      return gitBranch(
        args.name as string | undefined,
        args.path as string | undefined,
        workspaceRoot
      );
    case "gitCheckout":
      assertWorkspaceCapability(workspaceTarget, "write");
      return gitCheckout(args.ref as string, args.path as string | undefined, workspaceRoot);
    case "runCommand": {
      assertWorkspaceCapability(workspaceTarget, "execute");
      const cwd = (args.cwd as string | undefined) ?? undefined;
      const result = await localExec(args.command as string, cwd, {
        timeout: 60_000,
        workspaceRoot,
      });
      return result;
    }
    case "runInBackground": {
      const cwd = (args.cwd as string | undefined) ?? undefined;
      const result = await startBackgroundExec(args.command as string, cwd, workspaceRoot);
      if (result.success) {
        return {
          success: true,
          processId: result.processId,
          message: `Process started (id=${result.processId}). Output is streaming in the chat. Access dev servers at http://localhost:PORT from the device browser. Use stopProcess to terminate.`,
        };
      }
      return { success: false, error: result.error };
    }
    case "stopProcess": {
      killProcess(args.processId as number);
      return { success: true, message: `Process ${args.processId} stopped.` };
    }
    default:
      return null; // Not supported locally
  }
}
