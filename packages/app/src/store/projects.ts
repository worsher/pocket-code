// ── Project Data Store ────────────────────────────────────
// AsyncStorage adapter for the versioned mobile project catalog.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { randomUUID } from "expo-crypto";
import {
  createProject as createCatalogProject,
  createProjectFromRemote,
  createImportedProject as createImportedCatalogProject,
  resolveStoredCurrentProjectId,
  upgradeProjectCatalog,
  type Project,
  type ProjectIdFactories,
  type ProjectImportSource,
} from "./projectCatalog";

const STORAGE_KEY = "pocket-code:projects";
const BACKUP_KEY = "pocket-code:projects:backup";
const CORRUPT_KEY = "pocket-code:projects:corrupt";
const CURRENT_KEY = "pocket-code:current-project";
const SOURCE_DEVICE_KEY = "pocket-code:source-device-id";

let catalogWriteTail: Promise<void> = Promise.resolve();
let currentProjectWriteTail: Promise<void> = Promise.resolve();

export type { Project } from "./projectCatalog";

const RUNTIME_FACTORIES: ProjectIdFactories = {
  projectUuid: randomUUID,
  replicaUuid: randomUUID,
  storageUuid: randomUUID,
};

export function createProject(name: string, description?: string, gitUrl?: string): Project {
  return createCatalogProject(name, RUNTIME_FACTORIES, description, gitUrl);
}

export function adoptRemoteProject(projectId: string, displayName: string): Project {
  return createProjectFromRemote(projectId, displayName, RUNTIME_FACTORIES);
}

export function createImportedProject(name: string, source: ProjectImportSource): Project {
  return createImportedCatalogProject(name, source, RUNTIME_FACTORIES);
}

export async function getOrCreateSourceDeviceId(): Promise<string> {
  const existing = await AsyncStorage.getItem(SOURCE_DEVICE_KEY);
  if (existing) return existing;
  const created = `source_${randomUUID()}`;
  await AsyncStorage.setItem(SOURCE_DEVICE_KEY, created);
  return created;
}

function parseCatalogJson(raw: string | null): unknown[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function serializeWrite(
  tail: Promise<void>,
  write: () => Promise<void>
): { result: Promise<void>; tail: Promise<void> } {
  const result = tail.catch(() => undefined).then(write);
  return { result, tail: result.catch(() => undefined) };
}

async function preserveCorruptCatalog(raw: string): Promise<void> {
  await AsyncStorage.setItem(CORRUPT_KEY, JSON.stringify({ raw, detectedAt: Date.now() })).catch(
    () => {
      // Recovery must still be attempted when diagnostic persistence is full.
    }
  );
}

export async function loadProjects(): Promise<Project[]> {
  await catalogWriteTail.catch(() => undefined);
  let parsed: unknown = null;
  let needsRecoveryWrite = false;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw) {
      const current = parseCatalogJson(raw);
      if (current) {
        parsed = current;
      } else {
        await preserveCorruptCatalog(raw);
        parsed = parseCatalogJson(await AsyncStorage.getItem(BACKUP_KEY));
        needsRecoveryWrite = true;
      }
    }
  } catch {
    // An unavailable catalog is recovered to the compatibility default below.
  }

  const upgraded = upgradeProjectCatalog(parsed, RUNTIME_FACTORIES);
  if (upgraded.changed || needsRecoveryWrite) {
    await saveProjects(upgraded.projects).catch(() => {
      // Keep the in-memory catalog usable when persistence is temporarily
      // unavailable. A later update/load retries the versioned write.
    });
  }
  return upgraded.projects;
}

export async function saveProjects(projects: Project[]): Promise<void> {
  const payload = JSON.stringify(projects);
  const queued = serializeWrite(catalogWriteTail, async () => {
    const current = await AsyncStorage.getItem(STORAGE_KEY);
    if (parseCatalogJson(current)) {
      await AsyncStorage.setItem(BACKUP_KEY, current!);
    }
    await AsyncStorage.setItem(STORAGE_KEY, payload);
  });
  catalogWriteTail = queued.tail;
  await queued.result;
}

export async function loadCurrentProjectId(projects?: readonly Project[]): Promise<string> {
  await currentProjectWriteTail.catch(() => undefined);
  try {
    const storedId = await AsyncStorage.getItem(CURRENT_KEY);
    if (!projects) return storedId || "default";
    const resolvedId = resolveStoredCurrentProjectId(projects, storedId);
    if (resolvedId && resolvedId !== storedId) {
      await saveCurrentProjectId(resolvedId);
    }
    return resolvedId;
  } catch {
    return projects?.[0]?.id || "default";
  }
}

export async function saveCurrentProjectId(id: string): Promise<void> {
  const queued = serializeWrite(currentProjectWriteTail, () =>
    AsyncStorage.setItem(CURRENT_KEY, id)
  );
  currentProjectWriteTail = queued.tail;
  await queued.result;
}
