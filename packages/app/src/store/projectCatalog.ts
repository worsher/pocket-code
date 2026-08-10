import {
  createProjectId,
  createReplicaId,
  createStorageKey,
  parseLegacyProjectId,
  parseProjectId,
  parseReplicaId,
  parseStorageKey,
  type UuidFactory,
} from "@pocket-code/workspace-core";

export const PROJECT_CATALOG_VERSION = 2 as const;

export type MobileWorkspaceLayout = "v2" | "legacy-default" | "legacy-project";

export interface MobileReplicaCatalogEntry {
  id: string;
  storageKey: string;
  generation: number;
  layout: MobileWorkspaceLayout;
}

export interface RemoteReplicaCatalogEntry {
  id: string;
  generation: number;
  kind: "cloud" | "dev-binding";
  /** Stable identity of the remote catalog/database. */
  authorityId: string;
  /** Client-side route used to select this replica before reconnecting. */
  connectionKey: string;
  updatedAt: number;
}

export interface Project {
  catalogVersion: typeof PROJECT_CATALOG_VERSION;
  id: string;
  /** Previous catalog key, retained only while legacy data remains discoverable. */
  legacyId?: string;
  name: string;
  description: string;
  gitUrl?: string;
  lastSessionId?: string;
  customPrompt?: string;
  lastSyncTime?: number;
  /** 上次代码同步到的影子快照 commit(增量同步基准)。 */
  lastSyncedCommit?: string;
  cloudProjectId?: string;
  localReplica: MobileReplicaCatalogEntry;
  remoteReplicas?: RemoteReplicaCatalogEntry[];
  createdAt: number;
  updatedAt: number;
}

export interface CatalogUpgradeResult {
  projects: Project[];
  changed: boolean;
}

export interface ProjectIdFactories {
  projectUuid: UuidFactory;
  replicaUuid: UuidFactory;
  storageUuid: UuidFactory;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function createReplicaMetadata(
  layout: MobileWorkspaceLayout,
  factories: ProjectIdFactories
): MobileReplicaCatalogEntry {
  return {
    id: createReplicaId(factories.replicaUuid),
    storageKey: createStorageKey(factories.storageUuid),
    generation: 1,
    layout,
  };
}

function isValidV2Project(value: unknown): value is Project {
  if (!isRecord(value) || value.catalogVersion !== PROJECT_CATALOG_VERSION) return false;
  if (typeof value.id !== "string" || typeof value.name !== "string") return false;
  if (!isRecord(value.localReplica)) return false;

  try {
    parseReplicaId(String(value.localReplica.id));
    parseStorageKey(String(value.localReplica.storageKey));
    const layout = value.localReplica.layout;
    if (layout === "v2") parseProjectId(value.id);
    if (layout === "legacy-project") parseLegacyProjectId(value.id);
    if (layout === "legacy-default" && value.id !== "default") return false;
    if (!(["v2", "legacy-default", "legacy-project"] as unknown[]).includes(layout)) {
      return false;
    }
    return (
      Number.isInteger(value.localReplica.generation) && Number(value.localReplica.generation) > 0
    );
  } catch {
    return false;
  }
}

function parseRemoteReplica(value: unknown): RemoteReplicaCatalogEntry | null {
  if (!isRecord(value)) return null;
  try {
    const id = parseReplicaId(String(value.id ?? ""));
    const authorityId = parseReplicaId(String(value.authorityId ?? ""));
    const generation = Number(value.generation);
    const kind = value.kind;
    const connectionKey = value.connectionKey;
    const updatedAt = Number(value.updatedAt);
    if (
      !Number.isInteger(generation) ||
      generation < 1 ||
      (kind !== "cloud" && kind !== "dev-binding") ||
      typeof connectionKey !== "string" ||
      !connectionKey ||
      !Number.isFinite(updatedAt)
    ) {
      return null;
    }
    return { id, generation, kind, authorityId, connectionKey, updatedAt };
  } catch {
    return null;
  }
}

export function upsertRemoteReplica(
  project: Project,
  replica: RemoteReplicaCatalogEntry,
): Project {
  const parsed = parseRemoteReplica(replica);
  if (!parsed) throw new Error("Invalid remote replica catalog entry");
  const existing = project.remoteReplicas ?? [];
  const remoteReplicas = [
    ...existing.filter(
      (entry) =>
        !(
          entry.authorityId === parsed.authorityId &&
          entry.connectionKey === parsed.connectionKey
        ),
    ),
    parsed,
  ];
  return { ...project, remoteReplicas };
}

function migrateLegacyProject(
  value: unknown,
  factories: ProjectIdFactories,
  now: number
): Project | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;

  const rawLegacyId = value.id;
  let existingV2Id: string | undefined;
  if (value.catalogVersion === PROJECT_CATALOG_VERSION) {
    try {
      existingV2Id = parseProjectId(rawLegacyId);
    } catch {
      // Invalid v2 IDs are replaced below instead of becoming path segments.
    }
  }
  let safeLegacyId: string | undefined;
  if (!existingV2Id) {
    try {
      safeLegacyId = parseLegacyProjectId(rawLegacyId);
    } catch {
      // Unsafe legacy IDs remain metadata only and are moved to an empty v2
      // workspace; they are never interpreted as old filesystem paths.
    }
  }

  const layout: MobileWorkspaceLayout = existingV2Id
    ? "v2"
    : safeLegacyId
    ? safeLegacyId === "default"
      ? "legacy-default"
      : "legacy-project"
    : "v2";
  const id = existingV2Id ?? safeLegacyId ?? createProjectId(factories.projectUuid);

  return {
    catalogVersion: PROJECT_CATALOG_VERSION,
    id,
    legacyId: existingV2Id ? optionalString(value.legacyId) : rawLegacyId,
    name: optionalString(value.name) ?? "Untitled",
    description: optionalString(value.description) ?? "",
    gitUrl: optionalString(value.gitUrl),
    lastSessionId: optionalString(value.lastSessionId),
    customPrompt: optionalString(value.customPrompt),
    lastSyncTime: optionalNumber(value.lastSyncTime),
    lastSyncedCommit: optionalString(value.lastSyncedCommit),
    cloudProjectId: optionalString(value.cloudProjectId),
    localReplica: createReplicaMetadata(layout, factories),
    createdAt: optionalNumber(value.createdAt) ?? now,
    updatedAt: optionalNumber(value.updatedAt) ?? now,
  };
}

export function createProject(
  name: string,
  factories: ProjectIdFactories,
  description?: string,
  gitUrl?: string,
  now: number = Date.now()
): Project {
  return {
    catalogVersion: PROJECT_CATALOG_VERSION,
    id: createProjectId(factories.projectUuid),
    name,
    description: description || "",
    gitUrl,
    localReplica: createReplicaMetadata("v2", factories),
    createdAt: now,
    updatedAt: now,
  };
}

export function createProjectFromRemote(
  projectId: string,
  displayName: string,
  factories: ProjectIdFactories,
  now: number = Date.now(),
): Project {
  return {
    catalogVersion: PROJECT_CATALOG_VERSION,
    id: parseProjectId(projectId),
    name: displayName.trim() || "Remote project",
    description: "",
    localReplica: createReplicaMetadata("v2", factories),
    createdAt: now,
    updatedAt: now,
  };
}

export function upgradeProjectCatalog(
  value: unknown,
  factories: ProjectIdFactories,
  now: number = Date.now()
): CatalogUpgradeResult {
  const input = Array.isArray(value) ? value : [];
  let changed = !Array.isArray(value);
  const projects: Project[] = [];

  for (const item of input) {
    if (isValidV2Project(item)) {
      if (item.remoteReplicas === undefined) {
        projects.push(item);
      } else if (Array.isArray(item.remoteReplicas)) {
        const remoteReplicas = item.remoteReplicas
          .map(parseRemoteReplica)
          .filter((entry): entry is RemoteReplicaCatalogEntry => entry !== null);
        if (remoteReplicas.length === item.remoteReplicas.length) {
          projects.push(item);
        } else {
          projects.push({ ...item, remoteReplicas });
          changed = true;
        }
      } else {
        const repaired = { ...item };
        delete repaired.remoteReplicas;
        projects.push(repaired);
        changed = true;
      }
      continue;
    }
    const migrated = migrateLegacyProject(item, factories, now);
    if (migrated) projects.push(migrated);
    changed = true;
  }

  if (projects.length === 0) {
    // An existing installation may have used the old shared workspace without
    // ever persisting its implicit default project, so preserve that path.
    projects.push(
      migrateLegacyProject(
        {
          id: "default",
          name: "Default",
          description: "默认项目",
          createdAt: now,
          updatedAt: now,
        },
        factories,
        now
      )!
    );
    changed = true;
  }

  return { projects, changed };
}

export function resolveStoredCurrentProjectId(
  projects: readonly Project[],
  storedId: string | null | undefined
): string {
  return (
    projects.find((project) => project.id === storedId || project.legacyId === storedId)?.id ??
    projects[0]?.id ??
    ""
  );
}
