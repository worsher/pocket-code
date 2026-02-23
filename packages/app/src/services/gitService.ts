/**
 * Git service — wraps isomorphic-git for local git operations.
 *
 * Used in geek+local mode to provide git functionality without Termux.
 * All functions return { success, ...data } for consistency with other tools.
 */

import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { Paths, Directory } from "expo-file-system";
import { createFsAdapter } from "./expoFsAdapter";
import type { AppSettings } from "../store/settings";

// ── Workspace helpers ──────────────────────────────────

function getWorkspaceUri(): string {
  const dir = new Directory(Paths.document, "workspace");
  if (!dir.exists) dir.create({ idempotent: true });
  return dir.uri;
}

/** Get the fs adapter for the workspace */
function getFsAndDir(subDir?: string) {
  const workspaceUri = getWorkspaceUri();
  const fs = createFsAdapter(workspaceUri);
  // isomorphic-git uses absolute POSIX paths; "/" maps to workspace root
  const dir = subDir ? `/${subDir}` : "/";
  return { fs, dir };
}

// ── Auth helper ────────────────────────────────────────

/**
 * Inject credentials directly into an HTTPS URL.
 * e.g. https://gitee.com/user/repo → https://username:token@gitee.com/user/repo
 * This is more reliable than onAuth for some platforms (e.g. Gitee).
 */
function injectCredentialsIntoUrl(url: string, settings: AppSettings): string {
  try {
    // Extract hostname via regex (React Native URL API may not support username/password setters)
    const match = url.match(/^(https?:\/\/)([^/]+)(\/.*)?$/);
    if (!match) return url;

    const [, protocol, hostPart, pathPart = ""] = match;
    // hostPart could already contain user:pass@, strip it
    const hostname = hostPart.replace(/^[^@]*@/, "");

    console.log("[Git] Looking for credentials for host:", hostname);
    console.log("[Git] Available credentials:", settings.gitCredentials?.map((c) => `${c.platform}/${c.host} (token: ${c.token ? "yes" : "no"})`));

    const cred = settings.gitCredentials?.find((c) => c.host === hostname);
    if (cred?.token) {
      const username = encodeURIComponent(cred.username || "oauth2");
      const password = encodeURIComponent(cred.token);
      console.log("[Git] Credentials injected for:", cred.platform, "username:", cred.username || "oauth2");
      return `${protocol}${username}:${password}@${hostname}${pathPart}`;
    }

    console.log("[Git] No matching credentials found for host:", hostname);
    return url;
  } catch (e) {
    console.log("[Git] URL injection error:", e);
    return url;
  }
}

function createOnAuth(settings: AppSettings) {
  return (url: string) => {
    try {
      const hostMatch = url.match(/^https?:\/\/(?:[^@]*@)?([^/:]+)/);
      const host = hostMatch?.[1];
      if (!host) return { cancel: true };
      const cred = settings.gitCredentials?.find((c) => c.host === host);
      if (!cred?.token) return { cancel: true };
      return {
        username: cred.username || "oauth2",
        password: cred.token,
      };
    } catch {
      return { cancel: true };
    }
  };
}

// ── Git operations ─────────────────────────────────────

export async function gitClone(
  url: string,
  targetDir: string | undefined,
  settings: AppSettings
): Promise<{ success: boolean; error?: string }> {
  try {
    // Derive directory name from URL if not specified
    const dirName =
      targetDir ||
      url
        .split("/")
        .pop()
        ?.replace(/\.git$/, "") ||
      "repo";
    const { fs } = getFsAndDir();
    const dir = `/${dirName}`;

    const authUrl = injectCredentialsIntoUrl(url, settings);
    console.log("[Git] Clone original URL:", url);
    console.log("[Git] Clone auth URL:", authUrl.replace(/\/\/[^@]*@/, "//***@")); // mask credentials
    console.log("[Git] Clone target dir:", dir);

    await git.clone({
      fs,
      http,
      dir,
      url: authUrl,
      singleBranch: true,
      depth: 1,
      onAuth: createOnAuth(settings),
    });

    console.log("[Git] Clone completed successfully");
    return { success: true };
  } catch (err: any) {
    console.log("[Git] Clone failed:", err.message);
    return { success: false, error: err.message };
  }
}

export async function gitStatus(
  path?: string
): Promise<{
  success: boolean;
  files?: Array<{ filepath: string; status: string }>;
  error?: string;
}> {
  try {
    const { fs, dir } = getFsAndDir(path);

    const matrix = await git.statusMatrix({ fs, dir });
    const files = matrix
      .filter(([, head, workdir, stage]) => {
        // Filter out unchanged files (1,1,1)
        return !(head === 1 && workdir === 1 && stage === 1);
      })
      .map(([filepath, head, workdir, stage]) => {
        let status = "unknown";
        if (head === 0 && workdir === 2 && stage === 0) status = "new, untracked";
        else if (head === 0 && workdir === 2 && stage === 2) status = "added, staged";
        else if (head === 0 && workdir === 2 && stage === 3) status = "added, staged, with unstaged changes";
        else if (head === 1 && workdir === 2 && stage === 1) status = "modified, unstaged";
        else if (head === 1 && workdir === 2 && stage === 2) status = "modified, staged";
        else if (head === 1 && workdir === 2 && stage === 3) status = "modified, staged, with unstaged changes";
        else if (head === 1 && workdir === 0 && stage === 1) status = "deleted, unstaged";
        else if (head === 1 && workdir === 0 && stage === 0) status = "deleted, staged";
        else status = `H:${head} W:${workdir} S:${stage}`;
        return { filepath, status };
      });

    return { success: true, files };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function gitAdd(
  filepath: string,
  path?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const { fs, dir } = getFsAndDir(path);

    if (filepath === ".") {
      // Stage all changes
      const matrix = await git.statusMatrix({ fs, dir });
      for (const [file, , workdir] of matrix) {
        if (workdir === 0) {
          await git.remove({ fs, dir, filepath: file });
        } else {
          await git.add({ fs, dir, filepath: file });
        }
      }
    } else {
      await git.add({ fs, dir, filepath });
    }

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function gitCommit(
  message: string,
  path?: string
): Promise<{ success: boolean; sha?: string; error?: string }> {
  try {
    const { fs, dir } = getFsAndDir(path);

    const sha = await git.commit({
      fs,
      dir,
      message,
      author: {
        name: "Pocket Code",
        email: "pocket-code@local",
      },
    });

    return { success: true, sha };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function gitPush(
  settings: AppSettings,
  path?: string,
  remote?: string,
  branch?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const { fs, dir } = getFsAndDir(path);

    // Read the remote URL and inject credentials
    const remoteUrl = await git.getConfig({
      fs,
      dir,
      path: `remote.${remote || "origin"}.url`,
    });

    await git.push({
      fs,
      http,
      dir,
      remote: remote || "origin",
      ref: branch,
      url: remoteUrl ? injectCredentialsIntoUrl(remoteUrl as string, settings) : undefined,
      onAuth: createOnAuth(settings),
    });

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function gitPull(
  settings: AppSettings,
  path?: string,
  remote?: string,
  branch?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const { fs, dir } = getFsAndDir(path);

    // Read the remote URL and inject credentials
    const remoteUrl = await git.getConfig({
      fs,
      dir,
      path: `remote.${remote || "origin"}.url`,
    });

    await git.pull({
      fs,
      http,
      dir,
      remote: remote || "origin",
      ref: branch,
      singleBranch: true,
      author: {
        name: "Pocket Code",
        email: "pocket-code@local",
      },
      url: remoteUrl ? injectCredentialsIntoUrl(remoteUrl as string, settings) : undefined,
      onAuth: createOnAuth(settings),
    });

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function gitLog(
  path?: string,
  depth?: number
): Promise<{
  success: boolean;
  commits?: Array<{
    sha: string;
    message: string;
    author: string;
    date: string;
  }>;
  error?: string;
}> {
  try {
    const { fs, dir } = getFsAndDir(path);

    const commits = await git.log({ fs, dir, depth: depth || 10 });
    const result = commits.map((c) => ({
      sha: c.oid.slice(0, 7),
      message: c.commit.message.trim(),
      author: c.commit.author.name,
      date: new Date(c.commit.author.timestamp * 1000).toISOString(),
    }));

    return { success: true, commits: result };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function gitBranch(
  name?: string,
  path?: string
): Promise<{
  success: boolean;
  branches?: string[];
  current?: string;
  error?: string;
}> {
  try {
    const { fs, dir } = getFsAndDir(path);

    if (name) {
      // Create new branch
      await git.branch({ fs, dir, ref: name });
      return { success: true };
    }

    // List branches
    const branches = await git.listBranches({ fs, dir });
    const current = await git.currentBranch({ fs, dir });
    return { success: true, branches, current: current || undefined };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function gitCheckout(
  ref: string,
  path?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const { fs, dir } = getFsAndDir(path);

    await git.checkout({ fs, dir, ref });
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
