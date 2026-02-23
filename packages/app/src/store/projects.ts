// ── Project Data Store ────────────────────────────────────
// Manages multiple projects with persistent storage.

import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_KEY = "pocket-code:projects";
const CURRENT_KEY = "pocket-code:current-project";

export interface Project {
  id: string;
  name: string;
  description: string;
  gitUrl?: string;
  lastSessionId?: string;
  customPrompt?: string;
  createdAt: number;
  updatedAt: number;
}

const DEFAULT_PROJECT: Project = {
  id: "default",
  name: "Default",
  description: "默认项目",
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

export async function loadProjects(): Promise<Project[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [DEFAULT_PROJECT];
    const projects = JSON.parse(raw) as Project[];
    return projects.length > 0 ? projects : [DEFAULT_PROJECT];
  } catch {
    return [DEFAULT_PROJECT];
  }
}

export async function saveProjects(projects: Project[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
}

export async function loadCurrentProjectId(): Promise<string> {
  try {
    const id = await AsyncStorage.getItem(CURRENT_KEY);
    return id || "default";
  } catch {
    return "default";
  }
}

export async function saveCurrentProjectId(id: string): Promise<void> {
  await AsyncStorage.setItem(CURRENT_KEY, id);
}

export function createProject(name: string, description?: string, gitUrl?: string): Project {
  return {
    id: `proj_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name,
    description: description || "",
    gitUrl,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}
