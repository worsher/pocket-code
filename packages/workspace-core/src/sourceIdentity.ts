import type { DuplicateMatch, SourceIdentity, SourceIdentityInput } from "./types.js";

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function identityKey(...parts: string[]): string {
  return JSON.stringify(parts);
}

function stripTrailingSlashes(value: string): string {
  return value.length > 1 ? value.replace(/\/+$/, "") : value;
}

export function normalizeGitRemote(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Git remote must not be empty");

  const scpMatch = trimmed.match(/^([^/@\s]+@)?([^/:\s]+):(.+)$/);
  const urlValue =
    scpMatch && !trimmed.includes("://")
      ? `ssh://${scpMatch[1] ?? ""}${scpMatch[2]}/${scpMatch[3]}`
      : trimmed;

  try {
    const url = new URL(urlValue);
    const host = url.hostname.toLowerCase();
    const port = url.port ? `:${url.port}` : "";
    const path = url.pathname
      .replace(/\/{2,}/g, "/")
      .replace(/\/+$/, "")
      .replace(/\.git$/i, "")
      .replace(/^\//, "");

    if (!host || !path) throw new Error("Git remote must include host and path");
    return `${host}${port}/${path}`;
  } catch (error) {
    if (error instanceof Error && error.message === "Git remote must include host and path") {
      throw error;
    }

    // Local remotes are allowed, but remain device-scoped when used as a
    // locator. They intentionally do not collapse with hosted remotes.
    const localRemote = stripTrailingSlashes(trimmed.replace(/\\/g, "/")).replace(/\.git$/i, "");
    if (!localRemote) throw new Error("Git remote must not be empty");
    return localRemote;
  }
}

export function deriveSourceIdentity(input: SourceIdentityInput): SourceIdentity {
  const deviceId = nonEmpty(input.sourceDeviceId);
  if (!deviceId) throw new Error("Source device ID must not be empty");

  const stableFileId = nonEmpty(input.stableFileId);
  const platformHandleId = nonEmpty(input.platformHandleId);
  const rawLocator = nonEmpty(input.canonicalLocator);
  const locator = rawLocator ? stripTrailingSlashes(rawLocator) : undefined;
  const gitRemote = nonEmpty(input.gitRemote);
  const contentFingerprint = nonEmpty(input.contentFingerprint)?.toLowerCase();

  if (!stableFileId && !platformHandleId && !locator && !gitRemote && !contentFingerprint) {
    throw new Error("Source identity requires at least one identity signal");
  }

  const physicalSignal = stableFileId
    ? (["stable-file", stableFileId] as const)
    : platformHandleId
      ? (["platform-handle", platformHandleId] as const)
      : undefined;
  const strongKey = physicalSignal
    ? identityKey("physical", deviceId, input.sourceKind, physicalSignal[0], physicalSignal[1])
    : undefined;
  const weakKeys = new Set<string>();

  if (strongKey) weakKeys.add(strongKey);
  if (locator) weakKeys.add(identityKey("locator", deviceId, input.sourceKind, locator));
  if (gitRemote) weakKeys.add(identityKey("git", normalizeGitRemote(gitRemote)));
  if (contentFingerprint) weakKeys.add(identityKey("content", contentFingerprint));

  return {
    importMode: input.importMode,
    sourceKind: input.sourceKind,
    strongKey,
    weakKeys: [...weakKeys].sort(),
  };
}

export function classifySourceDuplicate(
  existing: SourceIdentity,
  candidate: SourceIdentity
): DuplicateMatch {
  if (
    existing.importMode === "linked" &&
    candidate.importMode === "linked" &&
    existing.strongKey &&
    existing.strongKey === candidate.strongKey
  ) {
    return { strength: "strong", matchedKey: existing.strongKey };
  }

  const candidateKeys = new Set(candidate.weakKeys);
  const matchedKey = existing.weakKeys.find((key) => candidateKeys.has(key));
  return matchedKey ? { strength: "weak", matchedKey } : { strength: "none" };
}
