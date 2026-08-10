import { randomUUID } from "crypto";
import { basename, isAbsolute, join, relative, resolve } from "path";
import { constants } from "fs";
import { access, mkdir, realpath, rm, stat } from "fs/promises";
import {
  getManagedWorkspaceRelativeRoots,
  runImportPipeline,
  type ImportPipelineResult,
  type ImportProbe,
  type SourceIdentity,
} from "@pocket-code/workspace-core";
import {
  bindLinkedWorkspaceProject,
  deleteWorkspaceProject,
  getWorkspaceAuthorityId,
  listWorkspaceProjects,
  type WorkspaceImportSourceRecord,
  type WorkspaceProjectRecord,
} from "./db.js";
import { getServerV2Root, getWorkspaceHandle } from "./tools.js";

export interface LinkedDirectoryProbe extends ImportProbe {
  readonly importMode: "linked";
  readonly sourceKind: "directory";
  readonly worktreePath: string;
}

interface LinkedDirectoryStage {
  stagedSnapshot: string;
  stagingRoot: string;
  committed?: WorkspaceProjectRecord;
}

export interface LinkedDirectoryCommit {
  project: WorkspaceProjectRecord;
  importSource: WorkspaceImportSourceRecord;
}

export type LinkedDirectoryImportResult = ImportPipelineResult<
  LinkedDirectoryProbe,
  LinkedDirectoryCommit
>;

export interface LinkedDirectorySourceStatus {
  projectId: string;
  state: "available" | "permission-lost" | "moved" | "missing" | "replaced" | "unsupported";
  checkedAt: number;
  canonicalLocator?: string;
  resolvedLocator?: string;
  stableFileId?: string;
  error?: string;
}

function dataRoot(): string {
  return getServerV2Root();
}

function pathsOverlap(first: string, second: string): boolean {
  const rel = relative(resolve(first), resolve(second));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function existingImportSources(userId: string) {
  return listWorkspaceProjects(userId).flatMap((project) =>
    project.importSource
      ? [{ projectId: project.projectId, identity: project.importSource.identity }]
      : []
  );
}

export async function bindLinkedDirectory(args: {
  userId: string;
  projectId: string;
  displayName?: string;
  path: string;
  allowWeakDuplicate?: boolean;
}): Promise<LinkedDirectoryImportResult> {
  return runImportPipeline({
    input: args.path,
    existingSources: existingImportSources(args.userId),
    allowWeakDuplicate: args.allowWeakDuplicate,
    adapter: {
      async probe(input): Promise<LinkedDirectoryProbe> {
        const worktreePath = await realpath(input);
        const managedRoot = resolve(dataRoot());
        if (pathsOverlap(managedRoot, worktreePath) || pathsOverlap(worktreePath, managedRoot)) {
          throw new Error("Linked workspace must not overlap Pocket Code managed storage");
        }
        const info = await stat(worktreePath);
        if (!info.isDirectory()) throw new Error("Linked workspace path is not a directory");
        const stableFileId = `${info.dev}:${info.ino}`;
        return {
          importMode: "linked",
          sourceKind: "directory",
          sourceDeviceId: getWorkspaceAuthorityId(),
          suggestedName: args.displayName?.trim() || basename(worktreePath) || "Linked project",
          canonicalLocator: worktreePath,
          stableFileId,
          sourceSnapshot: stableFileId,
          estimatedBytes: 0,
          worktreePath,
        };
      },
      async stage(probe): Promise<LinkedDirectoryStage> {
        const stagingRoot = join(dataRoot(), "staging", `import_${randomUUID().replace(/-/g, "")}`);
        await mkdir(stagingRoot, { recursive: true });
        return { stagingRoot, stagedSnapshot: probe.sourceSnapshot };
      },
      async verify(probe) {
        const currentPath = await realpath(probe.worktreePath);
        const info = await stat(currentPath);
        return `${info.dev}:${info.ino}`;
      },
      async commit({ probe, staged, identity, verifiedSnapshot }) {
        const importSource: WorkspaceImportSourceRecord = {
          mode: "linked",
          sourceKind: "directory",
          sourceDeviceId: probe.sourceDeviceId,
          canonicalLocator: probe.canonicalLocator,
          identity: identity as SourceIdentity,
          importedSnapshot: verifiedSnapshot,
          importedAt: Date.now(),
          writeBackPolicy: "linked",
        };
        const project = bindLinkedWorkspaceProject({
          userId: args.userId,
          projectId: args.projectId,
          displayName: probe.suggestedName,
          worktreePath: probe.worktreePath,
          importSource,
        });
        staged.committed = project;
        // Resolving the handle creates managed state/cache and revalidates the
        // linked directory without putting Pocket Code metadata in it.
        const handle = getWorkspaceHandle({
          sessionId: "",
          projectId: project.projectId,
          userId: args.userId,
        });
        await mkdir(handle.stateRoot, { recursive: true });
        await mkdir(handle.cacheRoot, { recursive: true });
        await rm(staged.stagingRoot, { recursive: true, force: true });
        return { project, importSource };
      },
      async rollback(staged) {
        await rm(staged.stagingRoot, { recursive: true, force: true });
        if (!staged.committed) return;
        deleteWorkspaceProject(args.userId, staged.committed.projectId);
        const roots = getManagedWorkspaceRelativeRoots(staged.committed.storageKey);
        await rm(join(dataRoot(), roots.projectRoot), { recursive: true, force: true });
      },
    },
  });
}

/** Revalidates a linked directory without searching or touching unrelated paths. */
export async function inspectLinkedDirectorySource(
  project: WorkspaceProjectRecord
): Promise<LinkedDirectorySourceStatus> {
  const checkedAt = Date.now();
  const source = project.importSource;
  const canonicalLocator = source?.canonicalLocator ?? project.worktreePath;
  if (source?.mode !== "linked" || source.sourceKind !== "directory" || !canonicalLocator) {
    return { projectId: project.projectId, state: "unsupported", checkedAt };
  }
  try {
    const resolvedLocator = await realpath(canonicalLocator);
    await access(resolvedLocator, constants.R_OK | constants.W_OK);
    const info = await stat(resolvedLocator);
    if (!info.isDirectory()) {
      return {
        projectId: project.projectId,
        state: "replaced",
        checkedAt,
        canonicalLocator,
        resolvedLocator,
      };
    }
    const stableFileId = `${info.dev}:${info.ino}`;
    if (stableFileId !== source.importedSnapshot) {
      return {
        projectId: project.projectId,
        state: "replaced",
        checkedAt,
        canonicalLocator,
        resolvedLocator,
        stableFileId,
      };
    }
    return {
      projectId: project.projectId,
      state: resolve(resolvedLocator) === resolve(canonicalLocator) ? "available" : "moved",
      checkedAt,
      canonicalLocator,
      resolvedLocator,
      stableFileId,
    };
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
    return {
      projectId: project.projectId,
      state: code === "EACCES" || code === "EPERM" ? "permission-lost" : "missing",
      checkedAt,
      canonicalLocator,
      error: error instanceof Error ? error.message : "Linked source is unavailable",
    };
  }
}
