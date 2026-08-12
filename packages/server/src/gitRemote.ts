import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  type GitCredentialProfile,
  type ResolvedGitCredential,
} from "./gitCredentialVault.js";
import { cleanupLegacyWorkspaceCredentials } from "./gitCredentials.js";
import { getServerV2Root } from "./tools.js";
import { isSensitiveWorkspacePath, SENSITIVE_GIT_EXCLUDES } from "./sensitiveWorkspacePath.js";
import type { GitRpcErrorCodeType } from "@pocket-code/wire";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT = 8 * 1024 * 1024;

function assertSafeRawRepositoryPath(value: string): void {
  if (value.includes("\\") || value.includes("\0")) {
    throw new GitRemoteError("invalid_request", "Repository URL path is invalid");
  }
  const match = value.match(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?/i);
  const rawPath = match?.[1] ?? "";
  for (const rawSegment of rawPath.split("/").filter(Boolean)) {
    let decoded = rawSegment;
    try {
      for (let pass = 0; pass < 3; pass += 1) {
        const next = decodeURIComponent(decoded);
        if (next === decoded) break;
        decoded = next;
      }
    } catch {
      throw new GitRemoteError("invalid_request", "Repository URL path is invalid");
    }
    if (
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      decoded.includes("\0")
    ) {
      throw new GitRemoteError("invalid_request", "Repository URL path is ambiguous");
    }
  }
}

export interface GitRpcErrorShape {
  code: GitRpcErrorCodeType;
  message: string;
  retryable?: boolean;
}

export class GitRemoteError extends Error {
  constructor(
    public readonly code: GitRpcErrorCodeType,
    message: string,
    public readonly retryable = false
  ) {
    super(message);
    this.name = "GitRemoteError";
  }
}

interface GitCommandOptions {
  cwd?: string;
  credential?: ResolvedGitCredential;
  timeoutMs?: number;
}

interface GitCommandResult {
  stdout: string;
  stderr: string;
}

function decodedUrlPath(pathname: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new GitRemoteError("invalid_request", "Repository URL path is invalid");
  }
  if (decoded.includes("\\") || decoded.includes("\0")) {
    throw new GitRemoteError("invalid_request", "Repository URL path is invalid");
  }
  if (decoded.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new GitRemoteError("invalid_request", "Repository URL cannot contain dot segments");
  }
  return decoded.replace(/\/+$/, "") || "/";
}

/** Validates exact HTTPS origin and an optional path boundary. */
export function assertGitRemoteMatchesProfile(
  repositoryUrl: string,
  profile: GitCredentialProfile
): string {
  assertSafeRawRepositoryPath(repositoryUrl);
  let remote: URL;
  let origin: URL;
  try {
    remote = new URL(repositoryUrl);
    origin = new URL(profile.origin);
  } catch {
    throw new GitRemoteError("invalid_request", "Repository URL is invalid");
  }
  if (
    remote.protocol !== "https:" ||
    remote.username ||
    remote.password ||
    remote.search ||
    remote.hash
  ) {
    throw new GitRemoteError(
      "invalid_request",
      "Repository URL must use HTTPS and must not contain credentials"
    );
  }
  if (remote.origin !== origin.origin) {
    throw new GitRemoteError("host_mismatch", "Credential profile does not match repository host");
  }
  const remotePath = decodedUrlPath(remote.pathname);
  if (profile.pathPrefix) {
    const prefix = decodedUrlPath(profile.pathPrefix);
    if (remotePath !== prefix && !remotePath.startsWith(`${prefix}/`)) {
      throw new GitRemoteError(
        "host_mismatch",
        "Credential profile does not match repository path"
      );
    }
  }
  if (remotePath === "/") {
    throw new GitRemoteError("invalid_request", "Repository URL requires a repository path");
  }
  return remote.toString();
}

export function redactSensitiveText(value: string, secrets: string[] = []): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/\b(authorization|password|token)=([^\s&]+)/gi, "$1=[REDACTED]");
}

function classifyGitFailure(stderr: string): GitRemoteError {
  const message = stderr.trim() || "Git operation failed";
  const lower = message.toLowerCase();
  if (lower.includes("expired") && (lower.includes("token") || lower.includes("credential"))) {
    return new GitRemoteError("token_expired", "Git credential has expired");
  }
  if (
    lower.includes("authentication failed") ||
    lower.includes("could not read username") ||
    lower.includes("invalid username or password") ||
    lower.includes("http basic: access denied") ||
    lower.includes("authentication required")
  ) {
    return new GitRemoteError("auth_required", "Git authentication failed");
  }
  if (
    lower.includes("permission denied") ||
    lower.includes("not allowed to") ||
    lower.includes("the requested url returned error: 403") ||
    lower.includes("write access to repository not granted")
  ) {
    return new GitRemoteError("permission_denied", "Git credential lacks repository permission");
  }
  if (
    lower.includes("repository not found") ||
    lower.includes("does not appear to be a git repository") ||
    lower.includes("the requested url returned error: 404")
  ) {
    return new GitRemoteError("repo_not_found", "Git repository was not found");
  }
  if (
    lower.includes("ssl certificate problem") ||
    lower.includes("certificate verify failed") ||
    lower.includes("server certificate verification failed")
  ) {
    return new GitRemoteError("tls_error", "Git server TLS certificate could not be verified");
  }
  if (
    lower.includes("could not resolve host") ||
    lower.includes("failed to connect") ||
    lower.includes("connection timed out") ||
    lower.includes("network is unreachable")
  ) {
    return new GitRemoteError("network_error", "Git server is unreachable", true);
  }
  if (
    lower.includes("not possible to fast-forward") || lower.includes("non-fast-forward")
  ) {
    return new GitRemoteError("non_fast_forward", "Git operation is not a fast-forward");
  }
  if (lower.includes("merge conflict")) {
    return new GitRemoteError("conflict", "Git operation requires conflict resolution");
  }
  return new GitRemoteError("internal_error", message.slice(0, 2000));
}

async function withAskpassEnvironment<T>(
  credential: ResolvedGitCredential | undefined,
  run: (env: NodeJS.ProcessEnv, askpassArgs: string[]) => Promise<T>
): Promise<T> {
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    LC_ALL: "C",
  };
  if (!credential) return run(baseEnv, []);

  const askpassRoot = join(getServerV2Root(), "runtime", "git-askpass");
  await mkdir(askpassRoot, { recursive: true, mode: 0o700 });
  await chmod(askpassRoot, 0o700);
  const temporary = await mkdtemp(join(askpassRoot, "request-"));
  await chmod(temporary, 0o700);
  const askpass = join(temporary, "askpass.sh");
  await writeFile(
    askpass,
    '#!/bin/sh\ncase "$1" in\n  *sername*) printf "%s" "$POCKET_CODE_GIT_USERNAME" ;;\n  *) printf "%s" "$POCKET_CODE_GIT_SECRET" ;;\nesac\n',
    { mode: 0o700 }
  );
  try {
    return await run(
      {
        ...baseEnv,
        GIT_ASKPASS: askpass,
        GIT_ASKPASS_REQUIRE: "force",
        POCKET_CODE_GIT_USERNAME: credential.profile.username || "oauth2",
        POCKET_CODE_GIT_SECRET: credential.secret,
      },
      ["-c", `core.askPass=${askpass}`, "-c", "credential.helper="]
    );
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function runGit(args: string[], options: GitCommandOptions = {}): Promise<GitCommandResult> {
  return withAskpassEnvironment(options.credential, async (env, askpassArgs) => {
    const safeArgs = [
      ...askpassArgs,
      "-c",
      "http.followRedirects=false",
      "-c",
      "credential.useHttpPath=true",
      ...args,
    ];
    try {
      const { stdout, stderr } = await execFileAsync("git", safeArgs, {
        cwd: options.cwd,
        env,
        encoding: "utf8",
        timeout: options.timeoutMs ?? 120_000,
        maxBuffer: MAX_GIT_OUTPUT,
        windowsHide: true,
      });
      return {
        stdout: String(stdout ?? ""),
        stderr: redactSensitiveText(String(stderr ?? ""), [options.credential?.secret ?? ""]),
      };
    } catch (error) {
      const failure = error as { stderr?: string; stdout?: string; message?: string };
      const diagnostic = redactSensitiveText(
        String(failure.stderr || failure.stdout || failure.message || "Git operation failed"),
        [options.credential?.secret ?? ""]
      );
      throw classifyGitFailure(diagnostic);
    }
  });
}

async function currentHead(workspace: string): Promise<string | undefined> {
  try {
    return (await runGit(["rev-parse", "--verify", "HEAD"], { cwd: workspace })).stdout.trim();
  } catch {
    return undefined;
  }
}

async function currentBranch(workspace: string): Promise<string> {
  try {
    const branch = (
      await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: workspace })
    ).stdout.trim();
    if (!branch) throw new Error("empty branch");
    return branch;
  } catch {
    throw new GitRemoteError("internal_error", "Git workspace has a detached HEAD");
  }
}

async function assertNoTrackedSensitivePaths(workspace: string): Promise<void> {
  const tracked = (await runGit(["ls-files", "-z"], { cwd: workspace })).stdout
    .split("\0")
    .filter(Boolean);
  if (tracked.some(isSensitiveWorkspacePath)) {
    throw new GitRemoteError(
      "unsupported",
      "Repository contains a reserved credential path and cannot be imported safely"
    );
  }
}

async function assertNoStagedSensitivePaths(workspace: string): Promise<void> {
  const staged = (await runGit(["diff", "--cached", "--name-only", "-z"], { cwd: workspace }))
    .stdout.split("\0")
    .filter(Boolean);
  if (staged.some(isSensitiveWorkspacePath)) {
    throw new GitRemoteError(
      "invalid_request",
      "Commit contains a reserved credential path and was not created"
    );
  }
}

function sanitizedStatus(value: string): string {
  return value
    .split("\n")
    .filter((line) => {
      const path = line.length > 3 ? line.slice(3).split(" -> ").at(-1) ?? "" : "";
      return !path || !isSensitiveWorkspacePath(path.replace(/^"|"$/g, ""));
    })
    .join("\n")
    .trim();
}

async function assertCleanWorkspace(workspace: string): Promise<void> {
  const status = (await runGit(["status", "--porcelain=v1"], { cwd: workspace })).stdout;
  if (status.trim()) {
    throw new GitRemoteError("dirty_worktree", "Git workspace has uncommitted changes");
  }
}

function ensureBranchName(branch: string | undefined): string | undefined {
  if (!branch) return undefined;
  if (
    branch.startsWith("-") ||
    branch.length > 255 ||
    /[\s~^:?*[\\\0]/.test(branch) ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.endsWith(".") ||
    branch.endsWith("/")
  ) {
    throw new GitRemoteError("invalid_request", "Git branch name is invalid");
  }
  return branch;
}

export async function testGitCredential(args: {
  repositoryUrl: string;
  credential: ResolvedGitCredential;
  capability?: "read" | "write";
}): Promise<{ read: boolean; write: boolean }> {
  const repositoryUrl = assertGitRemoteMatchesProfile(
    args.repositoryUrl,
    args.credential.profile
  );
  await runGit(["ls-remote", "--heads", repositoryUrl], {
    credential: args.credential,
    timeoutMs: 60_000,
  });
  if (args.capability !== "write") return { read: true, write: false };

  const probeRoot = join(getServerV2Root(), "runtime", "git-probes");
  await mkdir(probeRoot, { recursive: true, mode: 0o700 });
  await chmod(probeRoot, 0o700);
  const probe = await mkdtemp(join(probeRoot, "write-"));
  try {
    await runGit(["init", "-q"], { cwd: probe });
    await runGit(
      [
        "-c",
        "user.name=Pocket Code",
        "-c",
        "user.email=pocket@local",
        "commit",
        "--allow-empty",
        "-qm",
        "credential capability probe",
      ],
      { cwd: probe }
    );
    const ref = `refs/heads/pocket-code-credential-probe-${randomBytes(6).toString("hex")}`;
    await runGit(["push", "--dry-run", repositoryUrl, `HEAD:${ref}`], {
      cwd: probe,
      credential: args.credential,
      timeoutMs: 60_000,
    });
    return { read: true, write: true };
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
}

export async function atomicCloneGitRepository(args: {
  repositoryUrl: string;
  credential: ResolvedGitCredential;
  targetWorkspace: string;
  branch?: string;
  stagingRoot?: string;
}): Promise<{ head: string; branch?: string }> {
  const repositoryUrl = assertGitRemoteMatchesProfile(
    args.repositoryUrl,
    args.credential.profile
  );
  const branch = ensureBranchName(args.branch);
  const stagingRoot = resolve(args.stagingRoot ?? join(getServerV2Root(), "staging"));
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  await chmod(stagingRoot, 0o700);
  const staging = await mkdtemp(join(stagingRoot, "git-import-"));
  const target = resolve(args.targetWorkspace);
  const backup = `${target}.empty-${randomUUID()}`;
  let targetBackedUp = false;
  try {
    const cloneArgs = ["clone", "--origin", "origin"];
    if (branch) cloneArgs.push("--branch", branch, "--single-branch");
    cloneArgs.push("--", repositoryUrl, staging);
    await runGit(cloneArgs, { credential: args.credential, timeoutMs: 10 * 60_000 });
    await assertNoTrackedSensitivePaths(staging);
    const head = await currentHead(staging);
    if (!head) throw new GitRemoteError("internal_error", "Cloned repository has no HEAD commit");
    const savedOrigin = (await runGit(["remote", "get-url", "origin"], { cwd: staging })).stdout.trim();
    if (savedOrigin !== repositoryUrl) {
      throw new GitRemoteError("internal_error", "Cloned repository origin failed verification");
    }

    await mkdir(dirname(target), { recursive: true });
    if (existsSync(target)) {
      const metadata = await lstat(target);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new GitRemoteError("invalid_request", "Git import target is not an empty directory");
      }
      if ((await readdir(target)).length > 0) {
        throw new GitRemoteError("invalid_request", "Git import target is not empty");
      }
      await rename(target, backup);
      targetBackedUp = true;
    }
    await rename(staging, target);
    if (targetBackedUp) {
      await rm(backup, { recursive: true, force: true }).catch(() => undefined);
    }
    return { head, branch: await currentBranch(target).catch(() => branch) };
  } catch (error) {
    if (targetBackedUp && !existsSync(target) && existsSync(backup)) {
      await rename(backup, target).catch(() => undefined);
    }
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
    if (targetBackedUp && existsSync(backup)) {
      await rm(backup, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export type GitWorkspaceOperation = "status" | "pull" | "commit" | "push";

export async function runGitWorkspaceOperation(args: {
  workspace: string;
  operation: GitWorkspaceOperation;
  credential?: ResolvedGitCredential;
  commitMessage?: string;
}): Promise<{ head?: string; summary?: string }> {
  await cleanupLegacyWorkspaceCredentials(args.workspace);
  if (args.operation === "status") {
    const result = await runGit(["status", "--porcelain=v1", "--branch"], {
      cwd: args.workspace,
    });
    return { head: await currentHead(args.workspace), summary: sanitizedStatus(result.stdout) };
  }
  if (!args.credential) {
    throw new GitRemoteError("credential_not_found", "Git credential was not found");
  }
  if (args.operation === "commit") {
    const message = args.commitMessage?.trim();
    if (!message || message.length > 10_000 || /\0/.test(message)) {
      throw new GitRemoteError("invalid_request", "A valid commit message is required");
    }
    const excludes = SENSITIVE_GIT_EXCLUDES.map((pattern) => `:(exclude,glob)${pattern}`);
    await runGit(["add", "-A", "--", ".", ...excludes], { cwd: args.workspace });
    await assertNoStagedSensitivePaths(args.workspace);
    const staged = await runGit(["diff", "--cached", "--name-only", "-z"], {
      cwd: args.workspace,
    });
    if (!staged.stdout) {
      const head = await currentHead(args.workspace);
      if (!head) {
        throw new GitRemoteError("invalid_request", "Git workspace has no changes to commit");
      }
      return { head, summary: "No new changes; existing HEAD is ready to push" };
    }
    const result = await runGit(
      [
        "-c",
        "user.name=Pocket Code",
        "-c",
        "user.email=pocket@local",
        "commit",
        "-m",
        message,
      ],
      { cwd: args.workspace }
    );
    return {
      head: await currentHead(args.workspace),
      summary: result.stdout.trim().slice(0, 4000),
    };
  }

  const savedOrigin = (
    await runGit(["remote", "get-url", "origin"], { cwd: args.workspace })
  ).stdout.trim();
  assertGitRemoteMatchesProfile(savedOrigin, args.credential.profile);

  if (args.operation === "pull") {
    await assertCleanWorkspace(args.workspace);
    const branch = await currentBranch(args.workspace);
    const result = await runGit(["pull", "--ff-only", "--no-rebase", "origin", branch], {
      cwd: args.workspace,
      credential: args.credential,
      timeoutMs: 10 * 60_000,
    });
    return {
      head: await currentHead(args.workspace),
      summary: redactSensitiveText(`${result.stdout}${result.stderr}`, [args.credential.secret])
        .trim()
        .slice(0, 4000),
    };
  }

  // The protocol intentionally has no refspec/force option.  HEAD is pushed to
  // the current upstream branch using Git's normal non-fast-forward checks.
  const branch = await currentBranch(args.workspace);
  const result = await runGit(["push", "--porcelain", "origin", `HEAD:${branch}`], {
    cwd: args.workspace,
    credential: args.credential,
    timeoutMs: 10 * 60_000,
  });
  return {
    head: await currentHead(args.workspace),
    summary: redactSensitiveText(`${result.stdout}${result.stderr}`, [args.credential.secret])
      .trim()
      .slice(0, 4000),
  };
}

export function toGitRpcError(error: unknown): GitRpcErrorShape {
  if (error instanceof GitRemoteError) {
    return {
      code: error.code,
      message: redactSensitiveText(error.message),
      ...(error.retryable ? { retryable: true } : {}),
    };
  }
  return { code: "internal_error", message: "Git operation failed" };
}
