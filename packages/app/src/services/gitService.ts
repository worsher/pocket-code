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
import { normalizeWorkspaceRelativePath } from "@pocket-code/workspace-core";
import {
  createGitCredentialOnAuth,
  normalizeGitRemoteHttpsUrl,
  resolveGitCredentialProfile,
  type GitCredentialProfile,
} from "./gitCredentialProfiles";
import { readGitCredentialSecret } from "./gitCredentialVault";
import { isSensitiveGitContentPath } from "./gitSensitivePath";

export { sanitizeGitRemoteUrl } from "./gitUrl";

// ── Workspace helpers ──────────────────────────────────

function getWorkspaceUri(workspaceRoot?: string): string {
  const dir = workspaceRoot
    ? new Directory(workspaceRoot)
    : new Directory(Paths.document, "workspace");
  if (!dir.exists) dir.create({ idempotent: true });
  return dir.uri;
}

/** Get the fs adapter for the workspace */
function getFsAndDir(workspaceRoot?: string, subDir?: string) {
  const workspaceUri = getWorkspaceUri(workspaceRoot);
  const fs = createFsAdapter(workspaceUri);
  // isomorphic-git uses absolute POSIX paths; "/" maps to workspace root
  const safeSubDir = subDir ? normalizeWorkspaceRelativePath(subDir) : ".";
  const dir = safeSubDir === "." ? "/" : `/${safeSubDir}`;
  return { fs, dir };
}

// ── Auth helper ────────────────────────────────────────

type GitOnAuth =
  (url: string) => { username: string; password: string } | { cancel: true };

async function resolveOperationAuth(
  url: string,
  profiles: readonly GitCredentialProfile[],
  credentialProfileId?: string
): Promise<{ safeUrl: string; onAuth?: GitOnAuth }> {
  const safeUrl = normalizeGitRemoteHttpsUrl(url);
  const profile = resolveGitCredentialProfile(safeUrl, profiles, credentialProfileId);
  if (!profile) return { safeUrl };
  const secret = await readGitCredentialSecret(profile);
  return {
    safeUrl,
    // onAuth may be invoked after a redirect. The pure callback refuses
    // cross-origin, cross-port, and out-of-prefix credential forwarding.
    onAuth: createGitCredentialOnAuth(profile, secret),
  };
}

async function assertNoSensitiveTrackedPaths(
  fs: ReturnType<typeof createFsAdapter>,
  dir: string
): Promise<void> {
  const tracked = await git.listFiles({ fs, dir });
  if (tracked.some(isSensitiveGitContentPath)) {
    throw new Error("Repository contains a reserved credential path and cannot be imported safely");
  }
}

async function unstageSensitivePaths(
  fs: ReturnType<typeof createFsAdapter>,
  dir: string
): Promise<void> {
  const matrix = await git.statusMatrix({ fs, dir });
  for (const [filepath, , , stage] of matrix) {
    if (stage !== 0 && isSensitiveGitContentPath(filepath)) {
      await git.resetIndex({ fs, dir, filepath });
    }
  }
}

export async function probeGitRemote(
  url: string,
  settings: AppSettings,
  credentialProfileId?: string
): Promise<{ url: string; head: string }> {
  const { safeUrl, onAuth } = await resolveOperationAuth(
    url,
    settings.gitCredentialProfiles,
    credentialProfileId
  );
  const refs = await git.listServerRefs({
    http,
    url: safeUrl,
    prefix: "HEAD",
    symrefs: true,
    ...(onAuth ? { onAuth } : {}),
  });
  const head = refs.find((ref) => ref.ref === "HEAD")?.oid;
  if (!head) throw new Error("Git remote does not advertise a default HEAD");
  return { url: safeUrl, head };
}

export async function cloneGitIntoWorkspaceRoot(
  url: string,
  settings: AppSettings,
  workspaceRoot: string,
  credentialProfileId?: string
): Promise<string> {
  const { safeUrl, onAuth } = await resolveOperationAuth(
    url,
    settings.gitCredentialProfiles,
    credentialProfileId
  );
  const { fs } = getFsAndDir(workspaceRoot);
  await git.clone({
    fs,
    http,
    dir: "/",
    url: safeUrl,
    singleBranch: true,
    depth: 1,
    ...(onAuth ? { onAuth } : {}),
  });
  await assertNoSensitiveTrackedPaths(fs, "/");
  await git.setConfig({ fs, dir: "/", path: "remote.origin.url", value: safeUrl });
  return git.resolveRef({ fs, dir: "/", ref: "HEAD" });
}

export async function resolveGitWorkspaceHead(workspaceRoot: string): Promise<string> {
  const { fs } = getFsAndDir(workspaceRoot);
  return git.resolveRef({ fs, dir: "/", ref: "HEAD" });
}

// ── Git operations ─────────────────────────────────────

export async function gitClone(
  url: string,
  targetDir: string | undefined,
  settings: AppSettings,
  workspaceRoot?: string,
  credentialProfileId?: string
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
    const { fs } = getFsAndDir(workspaceRoot);
    const safeDirName = normalizeWorkspaceRelativePath(dirName);
    const dir = `/${safeDirName}`;

    const { safeUrl, onAuth } = await resolveOperationAuth(
      url,
      settings.gitCredentialProfiles,
      credentialProfileId
    );
    console.log("[Git] Clone remote:", safeUrl);
    console.log("[Git] Clone target dir:", dir);

    await git.clone({
      fs,
      http,
      dir,
      url: safeUrl,
      singleBranch: true,
      depth: 1,
      ...(onAuth ? { onAuth } : {}),
    });
    try {
      await assertNoSensitiveTrackedPaths(fs, dir);
    } catch (error) {
      const target = new Directory(getWorkspaceUri(workspaceRoot), ...safeDirName.split("/"));
      if (target.exists) target.delete();
      throw error;
    }

    console.log("[Git] Clone completed successfully");
    return { success: true };
  } catch (err: any) {
    console.log("[Git] Clone failed:", err.message);
    return { success: false, error: err.message };
  }
}

export async function gitStatus(
  path?: string,
  workspaceRoot?: string
): Promise<{
  success: boolean;
  files?: Array<{ filepath: string; status: string }>;
  error?: string;
}> {
  try {
    const { fs, dir } = getFsAndDir(workspaceRoot, path);

    const matrix = await git.statusMatrix({ fs, dir });
    const files = matrix
      .filter(([, head, workdir, stage]) => {
        // Filter out unchanged files (1,1,1)
        return !(head === 1 && workdir === 1 && stage === 1);
      })
      .filter(([filepath]) => !isSensitiveGitContentPath(filepath))
      .map(([filepath, head, workdir, stage]) => {
        let status: string;
        if (head === 0 && workdir === 2 && stage === 0) status = "new, untracked";
        else if (head === 0 && workdir === 2 && stage === 2) status = "added, staged";
        else if (head === 0 && workdir === 2 && stage === 3)
          status = "added, staged, with unstaged changes";
        else if (head === 1 && workdir === 2 && stage === 1) status = "modified, unstaged";
        else if (head === 1 && workdir === 2 && stage === 2) status = "modified, staged";
        else if (head === 1 && workdir === 2 && stage === 3)
          status = "modified, staged, with unstaged changes";
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
  path?: string,
  workspaceRoot?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const { fs, dir } = getFsAndDir(workspaceRoot, path);
    const safeFilepath = normalizeWorkspaceRelativePath(filepath);

    if (safeFilepath !== "." && isSensitiveGitContentPath(safeFilepath)) {
      throw new Error("Sensitive credential paths cannot be staged");
    }

    if (safeFilepath === ".") {
      // Stage all changes
      const matrix = await git.statusMatrix({ fs, dir });
      for (const [file, , workdir] of matrix) {
        if (isSensitiveGitContentPath(file)) {
          await git.resetIndex({ fs, dir, filepath: file });
          continue;
        }
        if (workdir === 0) {
          await git.remove({ fs, dir, filepath: file });
        } else {
          await git.add({ fs, dir, filepath: file });
        }
      }
    } else {
      await git.add({ fs, dir, filepath: safeFilepath });
    }

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function gitCommit(
  message: string,
  path?: string,
  workspaceRoot?: string
): Promise<{ success: boolean; sha?: string; error?: string }> {
  try {
    const { fs, dir } = getFsAndDir(workspaceRoot, path);

    await unstageSensitivePaths(fs, dir);

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
  branch?: string,
  workspaceRoot?: string,
  credentialProfileId?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const { fs, dir } = getFsAndDir(workspaceRoot, path);

    const remoteUrl = await git.getConfig({
      fs,
      dir,
      path: `remote.${remote || "origin"}.url`,
    });

    const auth = remoteUrl
      ? await resolveOperationAuth(
          remoteUrl as string,
          settings.gitCredentialProfiles,
          credentialProfileId
        )
      : undefined;
    if (remoteUrl && auth && auth.safeUrl !== remoteUrl) {
      await git.setConfig({
        fs,
        dir,
        path: `remote.${remote || "origin"}.url`,
        value: auth.safeUrl,
      });
    }

    await git.push({
      fs,
      http,
      dir,
      remote: remote || "origin",
      ref: branch,
      url: auth?.safeUrl,
      ...(auth?.onAuth ? { onAuth: auth.onAuth } : {}),
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
  branch?: string,
  workspaceRoot?: string,
  credentialProfileId?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const { fs, dir } = getFsAndDir(workspaceRoot, path);

    const remoteUrl = await git.getConfig({
      fs,
      dir,
      path: `remote.${remote || "origin"}.url`,
    });

    const auth = remoteUrl
      ? await resolveOperationAuth(
          remoteUrl as string,
          settings.gitCredentialProfiles,
          credentialProfileId
        )
      : undefined;
    if (remoteUrl && auth && auth.safeUrl !== remoteUrl) {
      await git.setConfig({
        fs,
        dir,
        path: `remote.${remote || "origin"}.url`,
        value: auth.safeUrl,
      });
    }

    await git.pull({
      fs,
      http,
      dir,
      remote: remote || "origin",
      ref: branch,
      singleBranch: true,
      fastForwardOnly: true,
      author: {
        name: "Pocket Code",
        email: "pocket-code@local",
      },
      url: auth?.safeUrl,
      ...(auth?.onAuth ? { onAuth: auth.onAuth } : {}),
    });

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function gitLog(
  path?: string,
  depth?: number,
  workspaceRoot?: string
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
    const { fs, dir } = getFsAndDir(workspaceRoot, path);

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
  path?: string,
  workspaceRoot?: string
): Promise<{
  success: boolean;
  branches?: string[];
  current?: string;
  error?: string;
}> {
  try {
    const { fs, dir } = getFsAndDir(workspaceRoot, path);

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
  path?: string,
  workspaceRoot?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const { fs, dir } = getFsAndDir(workspaceRoot, path);

    await git.checkout({ fs, dir, ref });
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
