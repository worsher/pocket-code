// ── Project Context ──────────────────────────────────────
// Provides project state across the app via React Context.

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from "react";
import type { WorkspaceHandle } from "@pocket-code/workspace-core";
import {
  type Project,
  loadProjects,
  saveProjects,
  loadCurrentProjectId,
  saveCurrentProjectId,
  createProject as createProjectRecord,
  adoptRemoteProject,
  getOrCreateSourceDeviceId,
} from "../store/projects";
import {
  upsertRemoteReplica as upsertRemoteReplicaRecord,
  type ProjectImportSource,
  type ProjectSyncEdge,
  type RemoteReplicaCatalogEntry,
  upsertProjectSyncEdge,
  handoffProjectWriterLease,
} from "../store/projectCatalog";
import {
  ensureMobileWorkspaceHandle,
  getLegacyMobileWorkspaceRoot,
  hasLegacyMobileWorkspace,
} from "../services/workspaceResolver";
import {
  importMobileDirectory,
  pickMobileProjectDirectory,
  type MobileDirectoryImportResult,
} from "../services/mobileDirectoryImport";
import {
  importMobileArchive,
  pickMobileProjectArchive,
  type MobileArchiveImportResult,
} from "../services/mobileArchiveImport";
import { importMobileGit, type MobileGitImportResult } from "../services/mobileGitImport";
import type { AppSettings } from "../store/settings";
import { cloneMobileWorkspace } from "../services/mobileSyncTransaction";
import { Directory } from "expo-file-system";
import {
  applyCopySourceOperation,
  previewCopySourceOperation,
  type CopySourceDirection,
  type CopySourcePreview,
} from "../services/copySourceSync";
import { gitAdd, gitCommit, gitPush, resolveGitWorkspaceHead } from "../services/gitService";

interface ProjectContextValue {
  projects: Project[];
  currentProject: Project | null;
  currentWorkspaceHandle: WorkspaceHandle | null;
  currentWorkspaceRoot?: string;
  switchProject: (projectId: string) => void;
  createProject: (name: string, description?: string, gitUrl?: string) => void;
  deleteProject: (projectId: string) => void;
  updateProject: (projectId: string, updates: Partial<Project>) => Promise<void>;
  updateSyncEdge: (projectId: string, edge: ProjectSyncEdge) => Promise<void>;
  saveLocalReplicaCopy: (projectId: string) => Promise<Project>;
  handoffWriter: (projectId: string, targetReplicaId: string) => Promise<Project>;
  previewCopySource: (
    projectId: string,
    direction: CopySourceDirection
  ) => Promise<CopySourcePreview>;
  applyCopySource: (
    projectId: string,
    direction: CopySourceDirection,
    force?: boolean
  ) => Promise<CopySourcePreview>;
  commitAndPushGitProject: (
    projectId: string,
    settings: AppSettings,
    message: string
  ) => Promise<string>;
  registerRemoteReplica: (
    projectId: string,
    replica: RemoteReplicaCatalogEntry,
    displayName?: string,
    importSource?: ProjectImportSource
  ) => void;
  importDirectoryProject: (
    allowWeakDuplicate?: boolean
  ) => Promise<MobileDirectoryImportResult | null>;
  importArchiveProject: (allowWeakDuplicate?: boolean) => Promise<MobileArchiveImportResult | null>;
  importGitProject: (
    url: string,
    settings: AppSettings,
    allowWeakDuplicate?: boolean
  ) => Promise<MobileGitImportResult>;
  registerLinkedProject: (args: {
    projectId: string;
    displayName: string;
    importSource: ProjectImportSource;
    remoteReplica: RemoteReplicaCatalogEntry;
  }) => Promise<Project>;
}

const ProjectContext = createContext<ProjectContextValue>({
  projects: [],
  currentProject: null,
  currentWorkspaceHandle: null,
  currentWorkspaceRoot: undefined,
  switchProject: () => {},
  createProject: () => {},
  deleteProject: () => {},
  updateProject: async () => {},
  updateSyncEdge: async () => {},
  saveLocalReplicaCopy: async () => {
    throw new Error("Project provider is unavailable");
  },
  handoffWriter: async () => {
    throw new Error("Project provider is unavailable");
  },
  previewCopySource: async () => {
    throw new Error("Project provider is unavailable");
  },
  applyCopySource: async () => {
    throw new Error("Project provider is unavailable");
  },
  commitAndPushGitProject: async () => {
    throw new Error("Project provider is unavailable");
  },
  registerRemoteReplica: () => {},
  importDirectoryProject: async () => null,
  importArchiveProject: async () => null,
  importGitProject: async () => {
    throw new Error("Project provider is unavailable");
  },
  registerLinkedProject: async () => {
    throw new Error("Project provider is unavailable");
  },
});

export function useProject() {
  return useContext(ProjectContext);
}

export function ProjectProvider({ children }: { children: React.ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentProjectId, setCurrentProjectId] = useState<string>("default");
  const [loaded, setLoaded] = useState(false);
  const projectsRef = useRef<Project[]>([]);
  const pendingImportSourceRef = useRef<Awaited<
    ReturnType<typeof pickMobileProjectDirectory>
  > | null>(null);
  const pendingArchiveRef = useRef<NonNullable<
    Awaited<ReturnType<typeof pickMobileProjectArchive>>
  > | null>(null);
  const pendingGitUrlRef = useRef<string | null>(null);
  projectsRef.current = projects;

  useEffect(() => {
    loadProjects({ preserveImplicitLegacyDefault: hasLegacyMobileWorkspace() }).then(
      async (loadedProjects) => {
        const loadedId = await loadCurrentProjectId(loadedProjects);
        setProjects(loadedProjects);
        projectsRef.current = loadedProjects;
        setCurrentProjectId(loadedId);
        setLoaded(true);
      }
    );
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
        projectsRef.current = updated;
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
        projectsRef.current = updated;
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

  const updateProject = useCallback(async (projectId: string, updates: Partial<Project>) => {
    const updated = projectsRef.current.map((project) =>
      project.id === projectId ? { ...project, ...updates, updatedAt: Date.now() } : project
    );
    projectsRef.current = updated;
    setProjects(updated);
    await saveProjects(updated);
  }, []);

  const updateSyncEdge = useCallback(async (projectId: string, edge: ProjectSyncEdge) => {
    const existing = projectsRef.current.find((project) => project.id === projectId);
    if (!existing) throw new Error("Project no longer exists");
    const replacement = { ...upsertProjectSyncEdge(existing, edge), updatedAt: Date.now() };
    const updated = projectsRef.current.map((project) =>
      project.id === projectId ? replacement : project
    );
    projectsRef.current = updated;
    setProjects(updated);
    await saveProjects(updated);
  }, []);

  const saveLocalReplicaCopy = useCallback(async (projectId: string): Promise<Project> => {
    const source = projectsRef.current.find((project) => project.id === projectId);
    if (!source || source.localReplica.layout !== "v2") {
      throw new Error("Only a managed v2 project can be saved as a local copy");
    }
    const copy = createProjectRecord(
      `${source.name} (本地副本)`,
      source.description,
      source.gitUrl
    );
    const sourceHandle = ensureMobileWorkspaceHandle(source);
    const copyHandle = ensureMobileWorkspaceHandle(copy);
    try {
      cloneMobileWorkspace(sourceHandle, copyHandle);
      const updated = [...projectsRef.current, copy];
      await saveProjects(updated);
      projectsRef.current = updated;
      setProjects(updated);
      return copy;
    } catch (error) {
      const projectRoot = new Directory(copyHandle.worktreeRoot).parentDirectory;
      if (projectRoot.exists) projectRoot.delete();
      throw error;
    }
  }, []);

  const handoffWriter = useCallback(
    async (projectId: string, targetReplicaId: string): Promise<Project> => {
      const current = projectsRef.current.find((project) => project.id === projectId);
      if (!current) throw new Error("Project no longer exists");
      const replacement = handoffProjectWriterLease(current, targetReplicaId);
      if (replacement === current) return current;
      const updated = projectsRef.current.map((project) =>
        project.id === projectId ? replacement : project
      );
      await saveProjects(updated);
      projectsRef.current = updated;
      setProjects(updated);
      return replacement;
    },
    []
  );

  const persistProjectImportSource = useCallback(
    async (projectId: string, importSource: ProjectImportSource): Promise<void> => {
      const current = projectsRef.current.find((project) => project.id === projectId);
      if (!current) throw new Error("Project no longer exists");
      const replacement = { ...current, importSource, updatedAt: Date.now() };
      const updated = projectsRef.current.map((project) =>
        project.id === projectId ? replacement : project
      );
      await saveProjects(updated);
      projectsRef.current = updated;
      setProjects(updated);
    },
    []
  );

  const previewCopySource = useCallback(
    async (projectId: string, direction: CopySourceDirection): Promise<CopySourcePreview> => {
      const project = projectsRef.current.find((entry) => entry.id === projectId);
      if (!project || project.localReplica.layout !== "v2") {
        throw new Error("Managed copy project is unavailable");
      }
      return previewCopySourceOperation(project, ensureMobileWorkspaceHandle(project), direction);
    },
    []
  );

  const applyCopySource = useCallback(
    async (
      projectId: string,
      direction: CopySourceDirection,
      force: boolean = false
    ): Promise<CopySourcePreview> => {
      const project = projectsRef.current.find((entry) => entry.id === projectId);
      if (!project || project.localReplica.layout !== "v2") {
        throw new Error("Managed copy project is unavailable");
      }
      const handle = ensureMobileWorkspaceHandle(project);
      if (!handle.capabilities.write) {
        throw new Error("Switch the project writer to this phone before synchronizing its source");
      }
      return applyCopySourceOperation({
        project,
        handle,
        direction,
        force,
        persistImportSource: (source) => persistProjectImportSource(projectId, source),
      });
    },
    [persistProjectImportSource]
  );

  const commitAndPushGitProject = useCallback(
    async (projectId: string, settings: AppSettings, message: string): Promise<string> => {
      const project = projectsRef.current.find((entry) => entry.id === projectId);
      if (
        !project ||
        project.localReplica.layout !== "v2" ||
        project.importSource?.mode !== "git" ||
        project.importSource.writeBackPolicy !== "git"
      ) {
        throw new Error("Project is not a managed Git import");
      }
      const handle = ensureMobileWorkspaceHandle(project);
      if (!handle.capabilities.write) {
        throw new Error("Switch the project writer to this phone before committing");
      }
      const summary = message.trim();
      if (!summary) throw new Error("Commit message must not be empty");
      const staged = await gitAdd(".", undefined, handle.worktreeRoot);
      if (!staged.success) throw new Error(staged.error ?? "Unable to stage Git changes");
      const committed = await gitCommit(summary, undefined, handle.worktreeRoot);
      if (!committed.success || !committed.sha) {
        throw new Error(committed.error ?? "Unable to commit Git changes");
      }
      const pushed = await gitPush(settings, undefined, "origin", undefined, handle.worktreeRoot);
      if (!pushed.success) throw new Error(pushed.error ?? "Unable to push Git changes");
      const head = await resolveGitWorkspaceHead(handle.worktreeRoot);
      await persistProjectImportSource(projectId, {
        ...project.importSource,
        importedSnapshot: head,
        importedAt: Date.now(),
      });
      return head;
    },
    [persistProjectImportSource]
  );

  const registerRemoteReplica = useCallback(
    (
      projectId: string,
      replica: RemoteReplicaCatalogEntry,
      displayName?: string,
      importSource?: ProjectImportSource
    ) => {
      setProjects((prev) => {
        const existing = prev.find((project) => project.id === projectId);
        const adopted = existing ?? adoptRemoteProject(projectId, displayName ?? "Remote project");
        const merged = {
          ...upsertRemoteReplicaRecord(adopted, replica),
          ...(displayName && !existing?.name ? { name: displayName } : {}),
          ...(importSource && !existing?.importSource ? { importSource } : {}),
          updatedAt: Date.now(),
        };
        const updated = existing
          ? prev.map((project) => (project.id === projectId ? merged : project))
          : [...prev, merged];
        projectsRef.current = updated;
        void saveProjects(updated).catch((error) => {
          console.error("[Projects] Failed to persist remote replica:", error);
        });
        return updated;
      });
    },
    []
  );

  const commitImportedProject = useCallback(async (project: Project): Promise<void> => {
    if (projectsRef.current.some((existing) => existing.id === project.id)) {
      throw new Error("Imported project ID already exists");
    }
    const updated = [...projectsRef.current, project];
    await saveProjects(updated);
    projectsRef.current = updated;
    setProjects(updated);
  }, []);

  const importDirectoryProject = useCallback(
    async (allowWeakDuplicate: boolean = false): Promise<MobileDirectoryImportResult | null> => {
      const source =
        allowWeakDuplicate && pendingImportSourceRef.current
          ? pendingImportSourceRef.current
          : await pickMobileProjectDirectory();
      pendingImportSourceRef.current = source;
      const result = await importMobileDirectory({
        source,
        sourceDeviceId: await getOrCreateSourceDeviceId(),
        projects: projectsRef.current,
        allowWeakDuplicate,
        commitProject: commitImportedProject,
      });
      if (result.status === "imported") {
        pendingImportSourceRef.current = null;
        switchProject(result.committed.id);
      } else if (result.status === "blocked") {
        pendingImportSourceRef.current = null;
      }
      return result;
    },
    [commitImportedProject, switchProject]
  );

  const importArchiveProject = useCallback(
    async (allowWeakDuplicate: boolean = false): Promise<MobileArchiveImportResult | null> => {
      const asset =
        allowWeakDuplicate && pendingArchiveRef.current
          ? pendingArchiveRef.current
          : await pickMobileProjectArchive();
      if (!asset) return null;
      pendingArchiveRef.current = asset;
      const result = await importMobileArchive({
        source: asset,
        sourceDeviceId: await getOrCreateSourceDeviceId(),
        projects: projectsRef.current,
        allowWeakDuplicate,
        commitProject: commitImportedProject,
      });
      if (result.status === "imported") {
        pendingArchiveRef.current = null;
        switchProject(result.committed.id);
      } else if (result.status === "blocked") {
        pendingArchiveRef.current = null;
      }
      return result;
    },
    [commitImportedProject, switchProject]
  );

  const importGitProject = useCallback(
    async (
      url: string,
      settings: AppSettings,
      allowWeakDuplicate: boolean = false
    ): Promise<MobileGitImportResult> => {
      const sourceUrl =
        allowWeakDuplicate && pendingGitUrlRef.current ? pendingGitUrlRef.current : url;
      pendingGitUrlRef.current = sourceUrl;
      const result = await importMobileGit({
        url: sourceUrl,
        settings,
        sourceDeviceId: await getOrCreateSourceDeviceId(),
        projects: projectsRef.current,
        allowWeakDuplicate,
        commitProject: commitImportedProject,
      });
      if (result.status === "imported") {
        pendingGitUrlRef.current = null;
        switchProject(result.committed.id);
      } else if (result.status === "blocked") {
        pendingGitUrlRef.current = null;
      }
      return result;
    },
    [commitImportedProject, switchProject]
  );

  const registerLinkedProject = useCallback(
    async (args: {
      projectId: string;
      displayName: string;
      importSource: ProjectImportSource;
      remoteReplica: RemoteReplicaCatalogEntry;
    }): Promise<Project> => {
      const project: Project = {
        ...adoptRemoteProject(args.projectId, args.displayName),
        importSource: args.importSource,
        remoteReplicas: [args.remoteReplica],
      };
      await commitImportedProject(project);
      switchProject(project.id);
      return project;
    },
    [commitImportedProject, switchProject]
  );

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
        updateSyncEdge,
        saveLocalReplicaCopy,
        handoffWriter,
        previewCopySource,
        applyCopySource,
        commitAndPushGitProject,
        registerRemoteReplica,
        importDirectoryProject,
        importArchiveProject,
        importGitProject,
        registerLinkedProject,
      }}
    >
      {children}
    </ProjectContext.Provider>
  );
}
