import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  GitCredentialVault,
  getGitCredentialVault,
  type GitCredentialProfile,
  type GitCredentialProvider,
} from "./gitCredentialVault.js";

const execFileAsync = promisify(execFile);

export interface LegacyGitCredential {
  platform: string;
  host: string;
  username?: string;
  token: string;
}

type LegacyCredentialFileName = ".git-credentials" | ".gitconfig";

const LEGACY_CREDENTIAL_CANDIDATES: Array<{
  name: LegacyCredentialFileName;
  generated: (value: string) => boolean;
}> = [
  {
    name: ".git-credentials",
    generated: (value) => {
      const lines = value.split(/\r?\n/).filter(Boolean);
      return (
        lines.length > 0 &&
        lines.every((line) => {
          try {
            const url = new URL(line);
            return url.protocol === "https:" && !!url.username && !!url.password && !/\s/.test(line);
          } catch {
            return false;
          }
        })
      );
    },
  },
  {
    name: ".gitconfig",
    generated: (value) =>
      /^\s*\[credential\]\s*\r?\n\s*helper\s*=\s*store\s*$/i.test(value),
  },
];

async function isTrackedByWorkspaceGit(workspace: string, name: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["ls-files", "--error-unmatch", "--", name], {
      cwd: workspace,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      },
      timeout: 5000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

export async function isGeneratedLegacyWorkspaceCredential(
  workspace: string,
  name: string
): Promise<boolean> {
  const candidate = LEGACY_CREDENTIAL_CANDIDATES.find((entry) => entry.name === name);
  if (!candidate) return false;
  try {
    const path = join(workspace, candidate.name);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return false;
    const content = await readFile(path, "utf8");
    return (
      candidate.generated(content) &&
      !(await isTrackedByWorkspaceGit(workspace, candidate.name))
    );
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return false;
    throw error;
  }
}

/** Deletes only files that older Pocket Code versions generated at workspace root. */
export async function cleanupLegacyWorkspaceCredentials(workspace: string): Promise<number> {
  let cleaned = 0;
  for (const candidate of LEGACY_CREDENTIAL_CANDIDATES) {
    try {
      const path = join(workspace, candidate.name);
      if (!(await isGeneratedLegacyWorkspaceCredential(workspace, candidate.name))) continue;
      await rm(path);
      cleaned++;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code !== "ENOENT") throw error;
    }
  }
  return cleaned;
}

function legacyProvider(platform: string): GitCredentialProvider {
  const normalized = platform.trim().toLowerCase();
  if (normalized === "github" || normalized === "gitee" || normalized === "gitlab") {
    return normalized;
  }
  // Old clients used platform only for display.  Custom origins were GitLab.
  return "gitlab";
}

function legacyOrigin(host: string): string {
  const candidate = host.includes("://") ? host : `https://${host}`;
  const url = new URL(candidate);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Legacy Git credential host is invalid");
  }
  return url.origin;
}

function legacyProfile(credential: LegacyGitCredential): GitCredentialProfile {
  const provider = legacyProvider(credential.platform);
  const origin = legacyOrigin(credential.host);
  const digest = createHash("sha256")
    .update(`${provider}\0${origin}\0${credential.username ?? ""}`)
    .digest("hex")
    .slice(0, 24);
  return {
    id: `legacy-${digest}`,
    label: `${provider} (migrated)`,
    provider,
    authKind: "pat",
    origin,
    ...(credential.username ? { username: credential.username } : {}),
  };
}

/**
 * One-release compatibility bridge for old init.gitCredentials payloads.  It
 * imports each secret into the encrypted data-root vault and removes the old
 * plaintext workspace files; it never configures Git's persistent store helper.
 */
export async function migrateLegacyGitCredentials(args: {
  workspace: string;
  userId: string;
  credentials?: LegacyGitCredential[];
  vault?: GitCredentialVault;
}): Promise<string[]> {
  await cleanupLegacyWorkspaceCredentials(args.workspace);
  const vault = args.vault ?? getGitCredentialVault();
  const migrated: string[] = [];
  for (const credential of args.credentials ?? []) {
    if (!credential.token) continue;
    const profile = legacyProfile(credential);
    await vault.upsert(args.userId, profile, credential.token);
    migrated.push(profile.id);
  }
  return migrated;
}
