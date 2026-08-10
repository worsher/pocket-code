import {
  createProjectId,
  createReplicaId,
  createStorageKey,
  parseLegacyProjectId,
  parseProjectId,
  parseReplicaId,
  parseStorageKey,
  type ImportMode,
  type ImportSourceKind,
  type SourceIdentity,
  type SyncPhase,
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

export interface ProjectImportSource {
  mode: ImportMode;
  sourceKind: ImportSourceKind;
  sourceDeviceId: string;
  canonicalLocator?: string;
  identity: SourceIdentity;
  importedSnapshot: string;
  importedAt: number;
  /** copy imports never write through to the locator. */
  writeBackPolicy: "explicit" | "linked" | "git";
}

export interface ProjectSyncConflict {
  baseSnapshot: string | null;
  localSnapshot: string;
  remoteSnapshot: string;
  detectedAt: number;
  resolution?: "keep-local" | "keep-remote" | "save-copy";
}

/** Sync state belongs to one local/remote replica edge, never to the project globally. */
export interface ProjectSyncEdge {
  localReplicaId: string;
  remoteReplicaId: string;
  remoteAuthorityId: string;
  baseSnapshot: string | null;
  localSnapshot: string | null;
  remoteSnapshot: string | null;
  /** Remote shadow commit used only as the incremental transfer cursor. */
  baseRemoteRef: string | null;
  phase: SyncPhase;
  transactionId?: string;
  conflict?: ProjectSyncConflict;
  updatedAt: number;
}

export interface ProjectWriterLease {
  holderReplicaId: string;
  generation: number;
  acquiredAt: number;
  expiresAt?: number;
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
  syncEdges?: ProjectSyncEdge[];
  writerLease?: ProjectWriterLease;
  importSource?: ProjectImportSource;
  createdAt: number;
  updatedAt: number;
}

export interface CatalogUpgradeResult {
  projects: Project[];
  changed: boolean;
}

export interface CatalogUpgradeOptions {
  /** Preserve the pre-v2 shared workspace only when it actually exists. */
  preserveImplicitLegacyDefault?: boolean;
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

function parseProjectImportSource(value: unknown): ProjectImportSource | null {
  if (!isRecord(value) || !isRecord(value.identity)) return null;
  const mode = value.mode;
  const sourceKind = value.sourceKind;
  const sourceDeviceId = value.sourceDeviceId;
  const canonicalLocator = value.canonicalLocator;
  const importedSnapshot = value.importedSnapshot;
  const importedAt = Number(value.importedAt);
  const writeBackPolicy = value.writeBackPolicy;
  const identity = value.identity;
  if (
    (mode !== "copy" && mode !== "linked" && mode !== "git") ||
    (sourceKind !== "directory" && sourceKind !== "archive" && sourceKind !== "git") ||
    typeof sourceDeviceId !== "string" ||
    !sourceDeviceId ||
    (canonicalLocator !== undefined && typeof canonicalLocator !== "string") ||
    typeof importedSnapshot !== "string" ||
    !importedSnapshot ||
    !Number.isFinite(importedAt) ||
    (writeBackPolicy !== "explicit" && writeBackPolicy !== "linked" && writeBackPolicy !== "git") ||
    identity.importMode !== mode ||
    identity.sourceKind !== sourceKind ||
    (identity.strongKey !== undefined && typeof identity.strongKey !== "string") ||
    !Array.isArray(identity.weakKeys) ||
    !identity.weakKeys.every((key) => typeof key === "string")
  ) {
    return null;
  }
  return {
    mode,
    sourceKind,
    sourceDeviceId,
    canonicalLocator: canonicalLocator as string | undefined,
    identity: {
      importMode: mode,
      sourceKind,
      strongKey: identity.strongKey as string | undefined,
      weakKeys: identity.weakKeys as string[],
    },
    importedSnapshot,
    importedAt,
    writeBackPolicy,
  };
}

const SYNC_PHASES: readonly SyncPhase[] = [
  "idle",
  "preparing",
  "transferring",
  "verifying",
  "applying",
  "committed",
  "failed",
  "conflict",
  "recovery-required",
];

function nullableSnapshot(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === "string" && value.length > 0 && value.length <= 128) return value;
  return undefined;
}

function parseProjectSyncEdge(value: unknown): ProjectSyncEdge | null {
  if (!isRecord(value)) return null;
  try {
    const localReplicaId = parseReplicaId(String(value.localReplicaId ?? ""));
    const remoteReplicaId = parseReplicaId(String(value.remoteReplicaId ?? ""));
    const remoteAuthorityId = parseReplicaId(String(value.remoteAuthorityId ?? ""));
    const baseSnapshot = nullableSnapshot(value.baseSnapshot);
    const localSnapshot = nullableSnapshot(value.localSnapshot);
    const remoteSnapshot = nullableSnapshot(value.remoteSnapshot);
    const baseRemoteRef = nullableSnapshot(value.baseRemoteRef);
    const phase = value.phase as SyncPhase;
    const updatedAt = Number(value.updatedAt);
    if (
      baseSnapshot === undefined ||
      localSnapshot === undefined ||
      remoteSnapshot === undefined ||
      baseRemoteRef === undefined ||
      !SYNC_PHASES.includes(phase) ||
      !Number.isFinite(updatedAt)
    ) {
      return null;
    }
    let conflict: ProjectSyncConflict | undefined;
    if (value.conflict !== undefined) {
      if (!isRecord(value.conflict)) return null;
      const conflictBase = nullableSnapshot(value.conflict.baseSnapshot);
      const conflictLocal = nullableSnapshot(value.conflict.localSnapshot);
      const conflictRemote = nullableSnapshot(value.conflict.remoteSnapshot);
      const detectedAt = Number(value.conflict.detectedAt);
      const resolution = value.conflict.resolution;
      if (
        conflictBase === undefined ||
        !conflictLocal ||
        !conflictRemote ||
        !Number.isFinite(detectedAt) ||
        (resolution !== undefined &&
          resolution !== "keep-local" &&
          resolution !== "keep-remote" &&
          resolution !== "save-copy")
      ) {
        return null;
      }
      conflict = {
        baseSnapshot: conflictBase,
        localSnapshot: conflictLocal,
        remoteSnapshot: conflictRemote,
        detectedAt,
        resolution,
      };
    }
    return {
      localReplicaId,
      remoteReplicaId,
      remoteAuthorityId,
      baseSnapshot,
      localSnapshot,
      remoteSnapshot,
      baseRemoteRef,
      phase,
      transactionId: optionalString(value.transactionId),
      conflict,
      updatedAt,
    };
  } catch {
    return null;
  }
}

function parseProjectWriterLease(value: unknown): ProjectWriterLease | null {
  if (!isRecord(value)) return null;
  try {
    const holderReplicaId = parseReplicaId(String(value.holderReplicaId ?? ""));
    const generation = Number(value.generation);
    const acquiredAt = Number(value.acquiredAt);
    const expiresAt = value.expiresAt === undefined ? undefined : Number(value.expiresAt);
    if (
      !Number.isInteger(generation) ||
      generation < 1 ||
      !Number.isFinite(acquiredAt) ||
      (expiresAt !== undefined && !Number.isFinite(expiresAt))
    ) {
      return null;
    }
    return { holderReplicaId, generation, acquiredAt, expiresAt };
  } catch {
    return null;
  }
}

export function upsertRemoteReplica(project: Project, replica: RemoteReplicaCatalogEntry): Project {
  const parsed = parseRemoteReplica(replica);
  if (!parsed) throw new Error("Invalid remote replica catalog entry");
  const existing = project.remoteReplicas ?? [];
  const remoteReplicas = [
    ...existing.filter(
      (entry) =>
        !(entry.authorityId === parsed.authorityId && entry.connectionKey === parsed.connectionKey)
    ),
    parsed,
  ];
  return { ...project, remoteReplicas };
}

export function getProjectSyncEdge(
  project: Project,
  remoteReplicaId: string
): ProjectSyncEdge | undefined {
  return project.syncEdges?.find(
    (edge) =>
      edge.localReplicaId === project.localReplica.id && edge.remoteReplicaId === remoteReplicaId
  );
}

export function upsertProjectSyncEdge(project: Project, edge: ProjectSyncEdge): Project {
  const parsed = parseProjectSyncEdge(edge);
  if (!parsed || parsed.localReplicaId !== project.localReplica.id) {
    throw new Error("Invalid project sync edge");
  }
  return {
    ...project,
    syncEdges: [
      ...(project.syncEdges ?? []).filter(
        (entry) =>
          !(
            entry.localReplicaId === parsed.localReplicaId &&
            entry.remoteReplicaId === parsed.remoteReplicaId
          )
      ),
      parsed,
    ],
  };
}

function edgeIsConverged(edge: ProjectSyncEdge): boolean {
  return (
    edge.phase === "committed" &&
    !!edge.baseSnapshot &&
    edge.localSnapshot === edge.baseSnapshot &&
    edge.remoteSnapshot === edge.baseSnapshot
  );
}

/**
 * Moves the single-writer role between replicas. A remote -> local handoff is
 * refused while any edge is divergent, and every successful switch bumps the
 * lease generation so stale async work can be rejected.
 */
export function handoffProjectWriterLease(
  project: Project,
  targetReplicaId: string,
  now: number = Date.now()
): Project {
  const target = parseReplicaId(targetReplicaId);
  const current = project.writerLease;
  if (current?.holderReplicaId === target) return project;
  if (
    current &&
    target === project.localReplica.id &&
    ((project.syncEdges?.length ?? 0) === 0 ||
      (project.syncEdges ?? []).some((edge) => !edgeIsConverged(edge)))
  ) {
    throw new Error("Writer handoff requires all replica edges to be converged");
  }
  const touchesLocal =
    !!current &&
    (current.holderReplicaId === project.localReplica.id || target === project.localReplica.id);
  return {
    ...project,
    localReplica: touchesLocal
      ? { ...project.localReplica, generation: project.localReplica.generation + 1 }
      : project.localReplica,
    writerLease: {
      holderReplicaId: target,
      generation: (current?.generation ?? 0) + 1,
      acquiredAt: now,
    },
    updatedAt: now,
  };
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
  now: number = Date.now()
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

export function createImportedProject(
  name: string,
  source: ProjectImportSource,
  factories: ProjectIdFactories,
  now: number = Date.now()
): Project {
  const parsedSource = parseProjectImportSource(source);
  if (!parsedSource) throw new Error("Invalid project import source metadata");
  return {
    ...createProject(name, factories, "", undefined, now),
    importSource: parsedSource,
  };
}

export function upgradeProjectCatalog(
  value: unknown,
  factories: ProjectIdFactories,
  now: number = Date.now(),
  options: CatalogUpgradeOptions = {}
): CatalogUpgradeResult {
  const input = Array.isArray(value) ? value : [];
  let changed = !Array.isArray(value);
  const projects: Project[] = [];

  for (const item of input) {
    if (isValidV2Project(item)) {
      let repaired: Project = item;
      if (item.remoteReplicas === undefined) {
        // Nothing to normalize.
      } else if (Array.isArray(item.remoteReplicas)) {
        const remoteReplicas = item.remoteReplicas
          .map(parseRemoteReplica)
          .filter((entry): entry is RemoteReplicaCatalogEntry => entry !== null);
        if (remoteReplicas.length === item.remoteReplicas.length) {
          // Already valid.
        } else {
          repaired = { ...repaired, remoteReplicas };
          changed = true;
        }
      } else {
        repaired = { ...repaired };
        delete repaired.remoteReplicas;
        changed = true;
      }
      if (item.importSource !== undefined) {
        const importSource = parseProjectImportSource(item.importSource);
        if (!importSource) {
          repaired = { ...repaired };
          delete repaired.importSource;
          changed = true;
        }
      }
      if (item.syncEdges !== undefined) {
        const syncEdges = Array.isArray(item.syncEdges)
          ? item.syncEdges
              .map(parseProjectSyncEdge)
              .filter((edge): edge is ProjectSyncEdge => edge !== null)
          : [];
        if (!Array.isArray(item.syncEdges) || syncEdges.length !== item.syncEdges.length) {
          repaired = { ...repaired, syncEdges };
          changed = true;
        }
      }
      if (item.writerLease !== undefined) {
        const writerLease = parseProjectWriterLease(item.writerLease);
        if (!writerLease) {
          repaired = { ...repaired };
          delete repaired.writerLease;
          changed = true;
        }
      }
      projects.push(repaired);
      continue;
    }
    const migrated = migrateLegacyProject(item, factories, now);
    if (migrated) projects.push(migrated);
    changed = true;
  }

  if (projects.length === 0) {
    if (options.preserveImplicitLegacyDefault) {
      // An existing installation may have used the old shared workspace
      // without persisting its implicit default project. Keep it discoverable
      // until the explicit legacy migration runs.
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
    } else {
      // Fresh installs must not create the old special "default" directory.
      projects.push(createProject("Default", factories, "默认项目", undefined, now));
    }
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
