// ── Project Context ──────────────────────────────────────
// Provides project state across the app via React Context.

import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from "react";
import type { WorkspaceHandle } from "@pocket-code/workspace-core";
import {
  type Project,
  loadProjects,
  saveProjects,
  loadCurrentProjectId,
  saveCurrentProjectId,
  createProject as createProjectRecord,
} from "../store/projects";
import {
  ensureMobileWorkspaceHandle,
  getLegacyMobileWorkspaceRoot,
} from "../services/workspaceResolver";

interface ProjectContextValue {
  projects: Project[];
  currentProject: Project | null;
  currentWorkspaceHandle: WorkspaceHandle | null;
  currentWorkspaceRoot?: string;
  switchProject: (projectId: string) => void;
  createProject: (name: string, description?: string, gitUrl?: string) => void;
  deleteProject: (projectId: string) => void;
  updateProject: (projectId: string, updates: Partial<Project>) => void;
}

const ProjectContext = createContext<ProjectContextValue>({
  projects: [],
  currentProject: null,
  currentWorkspaceHandle: null,
  currentWorkspaceRoot: undefined,
  switchProject: () => {},
  createProject: () => {},
  deleteProject: () => {},
  updateProject: () => {},
});

export function useProject() {
  return useContext(ProjectContext);
}

export function ProjectProvider({ children }: { children: React.ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentProjectId, setCurrentProjectId] = useState<string>("default");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    loadProjects().then(async (loadedProjects) => {
      const loadedId = await loadCurrentProjectId(loadedProjects);
      setProjects(loadedProjects);
      setCurrentProjectId(loadedId);
      setLoaded(true);
    });
  }, []);

  const currentProject = projects.find((p) => p.id === currentProjectId) || projects[0] || null;
  const currentWorkspace = useMemo(() => {
    if (!currentProject) return { handle: null, root: undefined };
    if (currentProject.localReplica.layout === "v2") {
      const handle = ensureMobileWorkspaceHandle(currentProject);
      return { handle, root: handle.worktreeRoot };
    }
    return { handle: null, root: getLegacyMobileWorkspaceRoot(currentProject) };
  }, [currentProject]);

  const switchProject = useCallback((projectId: string) => {
    setCurrentProjectId(projectId);
    void saveCurrentProjectId(projectId).catch((error) => {
      console.error("[Projects] Failed to persist current project:", error);
    });
  }, []);

  const createProject = useCallback(
    (name: string, description?: string, gitUrl?: string) => {
      const newProject = createProjectRecord(name, description, gitUrl);
      setProjects((prev) => {
        const updated = [...prev, newProject];
        void saveProjects(updated).catch((error) => {
          console.error("[Projects] Failed to persist created project:", error);
        });
        return updated;
      });
      switchProject(newProject.id);
    },
    [switchProject]
  );

  const deleteProject = useCallback(
    (projectId: string) => {
      if (projectId === "default") return; // Can't delete default
      setProjects((prev) => {
        const updated = prev.filter((p) => p.id !== projectId);
        void saveProjects(updated).catch((error) => {
          console.error("[Projects] Failed to persist deleted project:", error);
        });
        return updated;
      });
      if (currentProjectId === projectId) {
        switchProject("default");
      }
    },
    [currentProjectId, switchProject]
  );

  const updateProject = useCallback((projectId: string, updates: Partial<Project>) => {
    setProjects((prev) => {
      const updated = prev.map((p) =>
        p.id === projectId ? { ...p, ...updates, updatedAt: Date.now() } : p
      );
      void saveProjects(updated).catch((error) => {
        console.error("[Projects] Failed to persist project update:", error);
      });
      return updated;
    });
  }, []);

  if (!loaded) return null;

  return (
    <ProjectContext.Provider
      value={{
        projects,
        currentProject,
        currentWorkspaceHandle: currentWorkspace.handle,
        currentWorkspaceRoot: currentWorkspace.root,
        switchProject,
        createProject,
        deleteProject,
        updateProject,
      }}
    >
      {children}
    </ProjectContext.Provider>
  );
}
