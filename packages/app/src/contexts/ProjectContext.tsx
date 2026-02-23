// ── Project Context ──────────────────────────────────────
// Provides project state across the app via React Context.

import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import {
  type Project,
  loadProjects,
  saveProjects,
  loadCurrentProjectId,
  saveCurrentProjectId,
  createProject as createProjectRecord,
} from "../store/projects";

interface ProjectContextValue {
  projects: Project[];
  currentProject: Project | null;
  switchProject: (projectId: string) => void;
  createProject: (name: string, description?: string, gitUrl?: string) => void;
  deleteProject: (projectId: string) => void;
  updateProject: (projectId: string, updates: Partial<Project>) => void;
}

const ProjectContext = createContext<ProjectContextValue>({
  projects: [],
  currentProject: null,
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
    Promise.all([loadProjects(), loadCurrentProjectId()]).then(
      ([loadedProjects, loadedId]) => {
        setProjects(loadedProjects);
        setCurrentProjectId(loadedId);
        setLoaded(true);
      }
    );
  }, []);

  const currentProject = projects.find((p) => p.id === currentProjectId) || projects[0] || null;

  const switchProject = useCallback(
    (projectId: string) => {
      setCurrentProjectId(projectId);
      saveCurrentProjectId(projectId);
    },
    []
  );

  const createProject = useCallback(
    (name: string, description?: string, gitUrl?: string) => {
      const newProject = createProjectRecord(name, description, gitUrl);
      setProjects((prev) => {
        const updated = [...prev, newProject];
        saveProjects(updated);
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
        saveProjects(updated);
        return updated;
      });
      if (currentProjectId === projectId) {
        switchProject("default");
      }
    },
    [currentProjectId, switchProject]
  );

  const updateProject = useCallback(
    (projectId: string, updates: Partial<Project>) => {
      setProjects((prev) => {
        const updated = prev.map((p) =>
          p.id === projectId ? { ...p, ...updates, updatedAt: Date.now() } : p
        );
        saveProjects(updated);
        return updated;
      });
    },
    []
  );

  if (!loaded) return null;

  return (
    <ProjectContext.Provider
      value={{
        projects,
        currentProject,
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
