// ── Project Data Store ────────────────────────────────────
// AsyncStorage adapter for the versioned mobile project catalog.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { randomUUID } from "expo-crypto";
import {
  createProject as createCatalogProject,
  resolveStoredCurrentProjectId,
  upgradeProjectCatalog,
  type Project,
  type ProjectIdFactories,
} from "./projectCatalog";

const STORAGE_KEY = "pocket-code:projects";
const CURRENT_KEY = "pocket-code:current-project";

export type { Project } from "./projectCatalog";

const RUNTIME_FACTORIES: ProjectIdFactories = {
  projectUuid: randomUUID,
  replicaUuid: randomUUID,
  storageUuid: randomUUID,
};

export function createProject(name: string, description?: string, gitUrl?: string): Project {
  return createCatalogProject(name, RUNTIME_FACTORIES, description, gitUrl);
}

export async function loadProjects(): Promise<Project[]> {
  let parsed: unknown = null;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    // A corrupt catalog is recovered to the compatibility default below.
  }

  const upgraded = upgradeProjectCatalog(parsed, RUNTIME_FACTORIES);
  if (upgraded.changed) {
    await saveProjects(upgraded.projects).catch(() => {
      // Keep the in-memory catalog usable when persistence is temporarily
      // unavailable. A later update/load retries the versioned write.
    });
  }
  return upgraded.projects;
}

export async function saveProjects(projects: Project[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
}

export async function loadCurrentProjectId(projects?: readonly Project[]): Promise<string> {
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
  await AsyncStorage.setItem(CURRENT_KEY, id);
}
