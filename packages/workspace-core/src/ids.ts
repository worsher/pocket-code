import type { LegacyProjectId, ProjectId, ReplicaId, StorageKey } from "./types.js";

export type UuidFactory = () => string;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEGACY_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const STORAGE_KEY_PATTERN = /^ws_[0-9a-f]{32}$/;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function parseProjectId(value: string): ProjectId {
  if (!isUuid(value)) {
    throw new Error("Project ID must be a UUID");
  }
  return value.toLowerCase() as ProjectId;
}

export function parseReplicaId(value: string): ReplicaId {
  if (!isUuid(value)) {
    throw new Error("Replica ID must be a UUID");
  }
  return value.toLowerCase() as ReplicaId;
}

export function parseCatalogProjectKey(value: string): ProjectId | LegacyProjectId {
  return isUuid(value) ? parseProjectId(value) : parseLegacyProjectId(value);
}

export function createProjectId(uuidFactory: UuidFactory): ProjectId {
  return parseProjectId(uuidFactory());
}

export function createReplicaId(uuidFactory: UuidFactory): ReplicaId {
  return parseReplicaId(uuidFactory());
}

export function parseStorageKey(value: string): StorageKey {
  const normalized = value.toLowerCase();
  if (!STORAGE_KEY_PATTERN.test(normalized)) {
    throw new Error("Workspace storage key is invalid");
  }
  return normalized as StorageKey;
}

export function createStorageKey(uuidFactory: UuidFactory): StorageKey {
  const uuid = parseProjectId(uuidFactory());
  return parseStorageKey(`ws_${uuid.replaceAll("-", "")}`);
}

/**
 * Legacy IDs are migration lookup keys only. They must never be interpolated
 * into a filesystem path, even after this validation.
 */
export function parseLegacyProjectId(value: string): LegacyProjectId {
  if (
    !LEGACY_ID_PATTERN.test(value) ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    throw new Error("Invalid legacy project ID");
  }
  return value as LegacyProjectId;
}
