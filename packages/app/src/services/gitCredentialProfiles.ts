export type GitCredentialProvider = "github" | "gitee" | "gitlab";

export interface GitCredentialProfile {
  /** Stable local identifier. Projects bind to this value. */
  id: string;
  label: string;
  provider: GitCredentialProvider;
  authKind: "pat";
  /** Exact HTTPS origin, including a non-default port when configured. */
  origin: string;
  username?: string;
  /** Optional path boundary for self-hosted GitLab installations/namespaces. */
  pathPrefix?: string;
  /** Opaque SecureStore reference. It never contains the credential itself. */
  secretRef: string;
  /** Non-secret UI hint. The source of truth remains SecureStore. */
  hasSecret: boolean;
  updatedAt?: number;
}

export interface GitCredentialWireProfile {
  id: string;
  label?: string;
  provider: GitCredentialProvider;
  authKind: "pat";
  origin: string;
  username?: string;
  pathPrefix?: string;
}

export const BUILTIN_GIT_CREDENTIAL_PROFILES: readonly GitCredentialProfile[] = [
  {
    id: "github-pat",
    label: "GitHub API Key / PAT",
    provider: "github",
    authKind: "pat",
    origin: "https://github.com",
    username: "oauth2",
    secretRef: "git-credential.github-pat",
    hasSecret: false,
  },
  {
    id: "gitee-pat",
    label: "Gitee API Key / PAT",
    provider: "gitee",
    authKind: "pat",
    origin: "https://gitee.com",
    username: "oauth2",
    secretRef: "git-credential.gitee-pat",
    hasSecret: false,
  },
  {
    id: "gitlab-com-pat",
    label: "GitLab.com PAT",
    provider: "gitlab",
    authKind: "pat",
    origin: "https://gitlab.com",
    username: "oauth2",
    secretRef: "git-credential.gitlab-com-pat",
    hasSecret: false,
  },
];

const PROFILE_ID_PATTERN = /^[a-zA-Z0-9._-]{1,120}$/;

function decodeUrlPathSegment(segment: string): string {
  let decoded = segment;
  for (let pass = 0; pass < 3; pass += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      throw new Error("Git URL path contains invalid escaping");
    }
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

function assertSafeRawUrlPath(value: string): void {
  if (value.includes("\\") || value.includes("\0")) {
    throw new Error("Git URL path contains an invalid separator");
  }
  const match = value.match(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?/i);
  const rawPath = match?.[1] ?? "";
  for (const segment of rawPath.split("/").filter(Boolean)) {
    const decoded = decodeUrlPathSegment(segment);
    if (
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      decoded.includes("\0")
    ) {
      throw new Error("Git URL path contains an invalid or encoded separator");
    }
  }
}

export function secretRefForGitCredentialProfile(profileId: string): string {
  if (!PROFILE_ID_PATTERN.test(profileId)) {
    throw new Error("Git credential profile ID is invalid");
  }
  return `git-credential.${profileId}`;
}

export function normalizeGitCredentialOrigin(value: string): string {
  const input = value.trim();
  assertSafeRawUrlPath(input);
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("Git credential origin must be a valid HTTPS URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Git credential origin must use HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Git credential origin must not contain a username or token");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("Git credential origin must not contain a query or fragment");
  }
  if (parsed.pathname !== "/") {
    throw new Error("Put a self-hosted GitLab deployment path in pathPrefix");
  }
  return parsed.origin;
}

export function normalizeGitCredentialPathPrefix(value?: string): string | undefined {
  const input = value?.trim();
  if (!input || input === "/") return undefined;
  if (input.includes("?") || input.includes("#") || input.includes("\\")) {
    throw new Error("Git credential pathPrefix is invalid");
  }
  const segments = input
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      const decoded = decodeUrlPathSegment(segment);
      if (decoded === "." || decoded === "..") {
        throw new Error("Git credential pathPrefix must not contain dot segments");
      }
      if (decoded.includes("/") || decoded.includes("\\") || decoded.includes("\0")) {
        throw new Error("Git credential pathPrefix contains an encoded path separator");
      }
      return encodeURIComponent(decoded);
    });
  return segments.length > 0 ? `/${segments.join("/")}` : undefined;
}

export function normalizeGitCredentialProfile(
  profile: GitCredentialProfile
): GitCredentialProfile {
  if (!PROFILE_ID_PATTERN.test(profile.id)) {
    throw new Error("Git credential profile ID is invalid");
  }
  if (!(["github", "gitee", "gitlab"] as unknown[]).includes(profile.provider)) {
    throw new Error("Git credential provider is invalid");
  }
  if (profile.authKind !== "pat") {
    throw new Error("Only PAT/API Key authentication is supported in phase one");
  }
  const label = profile.label.trim();
  if (!label) throw new Error("Git credential profile label is required");
  const username = profile.username?.trim();
  if (username && /[\r\n\0]/.test(username)) {
    throw new Error("Git credential username is invalid");
  }
  return {
    ...profile,
    label,
    origin: normalizeGitCredentialOrigin(profile.origin),
    username: username || undefined,
    pathPrefix: normalizeGitCredentialPathPrefix(profile.pathPrefix),
    secretRef: secretRefForGitCredentialProfile(profile.id),
    hasSecret: profile.hasSecret === true,
  };
}

export function normalizeGitRemoteHttpsUrl(value: string): string {
  const input = value.trim();
  assertSafeRawUrlPath(input);
  if (input.includes("\\") || input.includes("\0")) {
    throw new Error("Git remote URL path is invalid");
  }
  // URL() normalizes literal and encoded dot segments before callers can inspect
  // them. Validate the raw path first so App-side profile matching applies the
  // same boundary to the exact string that will be sent to Git/the Server.
  const rawAuthority = input.match(/^https:\/\/[^/?#]*/i)?.[0];
  if (rawAuthority) {
    const rawPath = input.slice(rawAuthority.length).split(/[?#]/, 1)[0];
    for (const segment of rawPath.split("/")) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        throw new Error("Git remote URL path contains invalid escaping");
      }
      if (decoded === "." || decoded === "..") {
        throw new Error("Git remote URL path must not contain dot segments");
      }
      if (decoded.includes("/") || decoded.includes("\\") || decoded.includes("\0")) {
        throw new Error("Git remote URL path contains an encoded separator");
      }
    }
  }
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("Git remote must be a valid HTTPS URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Git remote must use HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Git remote URL must not contain a username or token");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("Git remote URL must not contain a query or fragment");
  }
  if (parsed.pathname === "/") {
    throw new Error("Git remote URL requires a repository path");
  }
  return parsed.toString();
}

export function gitCredentialProfileMatchesUrl(
  profile: GitCredentialProfile,
  remoteUrl: string
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(normalizeGitRemoteHttpsUrl(remoteUrl));
  } catch {
    return false;
  }
  const normalized = normalizeGitCredentialProfile(profile);
  if (parsed.origin !== normalized.origin) return false;
  if (!normalized.pathPrefix) return true;
  return (
    parsed.pathname === normalized.pathPrefix ||
    parsed.pathname.startsWith(`${normalized.pathPrefix}/`)
  );
}

export function matchingGitCredentialProfiles(
  remoteUrl: string,
  profiles: readonly GitCredentialProfile[]
): GitCredentialProfile[] {
  return profiles
    .filter((profile) => profile.hasSecret && gitCredentialProfileMatchesUrl(profile, remoteUrl))
    .map(normalizeGitCredentialProfile)
    .sort((left, right) => (right.pathPrefix?.length ?? 0) - (left.pathPrefix?.length ?? 0));
}

export function resolveGitCredentialProfile(
  remoteUrl: string,
  profiles: readonly GitCredentialProfile[],
  credentialProfileId?: string
): GitCredentialProfile | undefined {
  const normalizedUrl = normalizeGitRemoteHttpsUrl(remoteUrl);
  if (!credentialProfileId) return undefined;
  const profile = profiles.find((candidate) => candidate.id === credentialProfileId);
  if (!profile) throw new Error("The selected Git credential profile no longer exists");
  const normalized = normalizeGitCredentialProfile(profile);
  if (!normalized.hasSecret) {
    throw new Error(`Git credential “${normalized.label}” has no saved Key`);
  }
  if (!gitCredentialProfileMatchesUrl(normalized, normalizedUrl)) {
    throw new Error(`Git credential “${normalized.label}” is not allowed for this remote URL`);
  }
  return normalized;
}

export function createGitCredentialOnAuth(
  profile: GitCredentialProfile,
  secret: string
): (url: string) => { username: string; password: string } | { cancel: true } {
  const normalized = normalizeGitCredentialProfile(profile);
  return (requestedUrl: string) => {
    if (!gitCredentialProfileMatchesUrl(normalized, requestedUrl)) return { cancel: true };
    return {
      username: normalized.username || "oauth2",
      password: secret,
    };
  };
}

export function toGitCredentialWireProfile(
  profile: GitCredentialProfile
): GitCredentialWireProfile {
  const normalized = normalizeGitCredentialProfile(profile);
  return {
    id: normalized.id,
    label: normalized.label,
    provider: normalized.provider,
    authKind: normalized.authKind,
    origin: normalized.origin,
    username: normalized.username,
    pathPrefix: normalized.pathPrefix,
  };
}

export function mergeBuiltinGitCredentialProfiles(
  profiles: readonly GitCredentialProfile[]
): GitCredentialProfile[] {
  const normalized = new Map<string, GitCredentialProfile>();
  for (const profile of profiles) {
    try {
      normalized.set(profile.id, normalizeGitCredentialProfile(profile));
    } catch {
      // Invalid persisted metadata is ignored; secrets are never read here.
    }
  }
  for (const builtin of BUILTIN_GIT_CREDENTIAL_PROFILES) {
    const existing = normalized.get(builtin.id);
    normalized.set(
      builtin.id,
      existing
        ? normalizeGitCredentialProfile({
            ...existing,
            ...builtin,
            username: existing.username,
            hasSecret: existing.hasSecret,
            updatedAt: existing.updatedAt,
          })
        : { ...builtin }
    );
  }
  return Array.from(normalized.values());
}
