import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { getServerV2Root } from "./tools.js";

export type GitCredentialProvider = "github" | "gitee" | "gitlab";

export interface GitCredentialProfile {
  id: string;
  label?: string;
  provider: GitCredentialProvider;
  authKind: "pat";
  origin: string;
  username?: string;
  pathPrefix?: string;
}

export interface ResolvedGitCredential {
  profile: GitCredentialProfile;
  secret: string;
  createdAt: number;
  updatedAt: number;
}

interface VaultRecordV1 {
  version: 1;
  profile: GitCredentialProfile;
  iv: string;
  tag: string;
  ciphertext: string;
  createdAt: number;
  updatedAt: number;
}

const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_SECRET_BYTES = 64 * 1024;

export class GitCredentialVaultError extends Error {
  constructor(
    public readonly code:
      | "invalid_profile"
      | "credential_not_found"
      | "vault_corrupt"
      | "vault_unavailable",
    message: string
  ) {
    super(message);
    this.name = "GitCredentialVaultError";
  }
}

function normalizePathPrefix(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!value.startsWith("/") || value.includes("\\") || value.includes("\0")) {
    throw new GitCredentialVaultError("invalid_profile", "pathPrefix must be an absolute URL path");
  }
  for (const rawSegment of value.split("/").filter(Boolean)) {
    let decoded = rawSegment;
    try {
      for (let pass = 0; pass < 3; pass += 1) {
        const next = decodeURIComponent(decoded);
        if (next === decoded) break;
        decoded = next;
      }
    } catch {
      throw new GitCredentialVaultError("invalid_profile", "pathPrefix is invalid");
    }
    if (
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      decoded.includes("\0")
    ) {
      throw new GitCredentialVaultError(
        "invalid_profile",
        "pathPrefix contains an invalid or encoded separator"
      );
    }
  }
  const parsed = new URL(value, "https://profile.invalid");
  if (parsed.origin !== "https://profile.invalid" || parsed.search || parsed.hash) {
    throw new GitCredentialVaultError("invalid_profile", "pathPrefix is invalid");
  }
  const normalized = parsed.pathname.replace(/\/+$/, "");
  return normalized && normalized !== "/" ? normalized : undefined;
}

export function normalizeGitCredentialProfile(input: GitCredentialProfile): GitCredentialProfile {
  if (!PROFILE_ID_PATTERN.test(input.id)) {
    throw new GitCredentialVaultError("invalid_profile", "Credential profile ID is invalid");
  }
  if (!(["github", "gitee", "gitlab"] as string[]).includes(input.provider)) {
    throw new GitCredentialVaultError("invalid_profile", "Git credential provider is invalid");
  }
  if (input.authKind !== "pat") {
    throw new GitCredentialVaultError("invalid_profile", "Only PAT authentication is supported");
  }
  let url: URL;
  try {
    url = new URL(input.origin);
  } catch {
    throw new GitCredentialVaultError("invalid_profile", "Credential origin is not a valid URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new GitCredentialVaultError(
      "invalid_profile",
      "Credential origin must be an HTTPS origin without credentials or a path"
    );
  }
  if (!url.hostname) {
    throw new GitCredentialVaultError("invalid_profile", "Credential origin requires a host");
  }
  const username = input.username?.trim();
  if (username && /[\r\n\0]/.test(username)) {
    throw new GitCredentialVaultError("invalid_profile", "Credential username is invalid");
  }
  const label = input.label?.trim();
  const pathPrefix = normalizePathPrefix(input.pathPrefix);
  return {
    id: input.id,
    ...(label ? { label: label.slice(0, 256) } : {}),
    provider: input.provider,
    authKind: "pat",
    origin: url.origin,
    ...(username ? { username: username.slice(0, 256) } : {}),
    ...(pathPrefix ? { pathPrefix } : {}),
  };
}

function hashComponent(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function atomicPrivateWrite(path: string, content: Buffer | string): Promise<void> {
  await ensurePrivateDirectory(dirname(path));
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await chmod(path, 0o600);
}

/**
 * Encrypted, per-user credential persistence outside every worktree.  Paths use
 * hashes so user/profile input never becomes a filesystem segment.
 */
export class GitCredentialVault {
  readonly root: string;
  private readonly keyPath: string;
  private keyPromise?: Promise<Buffer>;

  constructor(root = join(getServerV2Root(), "runtime", "git-credentials")) {
    this.root = resolve(root);
    this.keyPath = join(this.root, "master.key");
  }

  private userDirectory(userId: string): string {
    if (!userId || userId.includes("\0")) {
      throw new GitCredentialVaultError("invalid_profile", "User ID is required");
    }
    return join(this.root, "users", hashComponent(userId));
  }

  private recordPath(userId: string, profileId: string): string {
    if (!PROFILE_ID_PATTERN.test(profileId)) {
      throw new GitCredentialVaultError("invalid_profile", "Credential profile ID is invalid");
    }
    return join(this.userDirectory(userId), `${hashComponent(profileId)}.json`);
  }

  private async loadOrCreateKey(): Promise<Buffer> {
    await ensurePrivateDirectory(this.root);
    try {
      const existing = await readFile(this.keyPath);
      if (existing.byteLength !== 32) {
        throw new GitCredentialVaultError("vault_corrupt", "Credential vault key is invalid");
      }
      await chmod(this.keyPath, 0o600);
      return existing;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (error instanceof GitCredentialVaultError || (code && code !== "ENOENT")) throw error;
    }

    const candidate = randomBytes(32);
    try {
      const handle = await open(this.keyPath, "wx", 0o600);
      try {
        await handle.writeFile(candidate);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return candidate;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code !== "EEXIST") throw error;
      const existing = await readFile(this.keyPath);
      if (existing.byteLength !== 32) {
        throw new GitCredentialVaultError("vault_corrupt", "Credential vault key is invalid");
      }
      return existing;
    }
  }

  private key(): Promise<Buffer> {
    return (this.keyPromise ??= this.loadOrCreateKey());
  }

  async upsert(
    userId: string,
    inputProfile: GitCredentialProfile,
    secret: string
  ): Promise<Omit<ResolvedGitCredential, "secret">> {
    const profile = normalizeGitCredentialProfile(inputProfile);
    if (!secret || Buffer.byteLength(secret, "utf8") > MAX_SECRET_BYTES || /[\r\n\0]/.test(secret)) {
      throw new GitCredentialVaultError("invalid_profile", "Credential secret is invalid");
    }
    const path = this.recordPath(userId, profile.id);
    let createdAt = Date.now();
    try {
      const existing = await this.read(userId, profile.id);
      createdAt = existing.createdAt;
    } catch (error) {
      if (!(error instanceof GitCredentialVaultError) || error.code !== "credential_not_found") {
        throw error;
      }
    }
    const updatedAt = Date.now();
    const iv = randomBytes(12);
    const aad = Buffer.from(`pocket-code/git-credential/v1\0${userId}\0${profile.id}`, "utf8");
    const cipher = createCipheriv("aes-256-gcm", await this.key(), iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    const record: VaultRecordV1 = {
      version: 1,
      profile,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      createdAt,
      updatedAt,
    };
    await atomicPrivateWrite(path, JSON.stringify(record));
    return { profile, createdAt, updatedAt };
  }

  async read(userId: string, profileId: string): Promise<ResolvedGitCredential> {
    const path = this.recordPath(userId, profileId);
    let record: VaultRecordV1;
    try {
      const metadata = await stat(path);
      if (!metadata.isFile() || metadata.size > 128 * 1024) {
        throw new GitCredentialVaultError("vault_corrupt", "Git credential record is invalid");
      }
      record = JSON.parse(await readFile(path, "utf8")) as VaultRecordV1;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (error instanceof GitCredentialVaultError) throw error;
      if (code === "ENOENT") {
        throw new GitCredentialVaultError("credential_not_found", "Git credential was not found");
      }
      throw new GitCredentialVaultError("vault_corrupt", "Git credential record is unreadable");
    }
    if (
      record.version !== 1 ||
      record.profile?.id !== profileId ||
      !Number.isSafeInteger(record.createdAt) ||
      !Number.isSafeInteger(record.updatedAt) ||
      typeof record.iv !== "string" ||
      typeof record.tag !== "string" ||
      typeof record.ciphertext !== "string" ||
      record.iv.length > 64 ||
      record.tag.length > 64 ||
      record.ciphertext.length > 100_000
    ) {
      throw new GitCredentialVaultError("vault_corrupt", "Git credential record is invalid");
    }
    const profile = normalizeGitCredentialProfile(record.profile);
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        await this.key(),
        Buffer.from(record.iv, "base64")
      );
      decipher.setAAD(
        Buffer.from(`pocket-code/git-credential/v1\0${userId}\0${profile.id}`, "utf8")
      );
      decipher.setAuthTag(Buffer.from(record.tag, "base64"));
      const secret = Buffer.concat([
        decipher.update(Buffer.from(record.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
      return { profile, secret, createdAt: record.createdAt, updatedAt: record.updatedAt };
    } catch (error) {
      if (error instanceof GitCredentialVaultError) throw error;
      throw new GitCredentialVaultError("vault_corrupt", "Git credential could not be decrypted");
    }
  }

  async delete(userId: string, profileId: string): Promise<boolean> {
    const path = this.recordPath(userId, profileId);
    try {
      await rm(path);
      return true;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code === "ENOENT") return false;
      throw error;
    }
  }
}

export function getGitCredentialVault(): GitCredentialVault {
  return new GitCredentialVault();
}
