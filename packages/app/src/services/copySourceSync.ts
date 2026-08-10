import { Directory, File } from "expo-file-system";
import { randomUUID } from "expo-crypto";
import { zipSync } from "fflate";
import {
  classifyCopySourceReconciliation,
  refreshSourceIdentityContent,
  type CopySourceDecision,
  type WorkspaceHandle,
} from "@pocket-code/workspace-core";
import type { MobileImportManifestEntry } from "./mobileDirectoryImport";
import {
  assertMobileImportSpace,
  copyMobileDirectoryContents,
  createMobileImportStagingDirectory,
  scanMobileDirectory,
} from "./mobileDirectoryImport";
import { inspectZipArchive, writeArchiveToDirectory } from "./mobileArchiveImport";
import { getMobileV2Root } from "./workspaceResolver";
import type { Project, ProjectImportSource } from "../store/projectCatalog";

export type CopySourceDirection = "reimport" | "write-back";

export interface CopySourceChange {
  path: string;
  status: "A" | "M" | "D";
  type: "directory" | "file";
}

export interface CopySourcePreview {
  direction: CopySourceDirection;
  decision: CopySourceDecision;
  importedSnapshot: string;
  workspaceSnapshot: string;
  sourceSnapshot: string;
  changes: CopySourceChange[];
}

interface LoadedCopySource {
  snapshot: string;
  bytes: number;
  manifest: MobileImportManifestEntry[];
  directory?: Directory;
  archiveFile?: File;
  archive?: Awaited<ReturnType<typeof inspectZipArchive>>;
}

function assertCopyProject(project: Project, handle: WorkspaceHandle): ProjectImportSource {
  const source = project.importSource;
  if (project.id !== handle.projectId) throw new Error("Workspace handle does not match project");
  if (
    !source ||
    source.mode !== "copy" ||
    source.writeBackPolicy !== "explicit" ||
    !source.canonicalLocator
  ) {
    throw new Error("Project does not have an explicit copy source");
  }
  if (source.sourceKind !== "directory" && source.sourceKind !== "archive") {
    throw new Error("This source type cannot use file overwrite synchronization");
  }
  return source;
}

async function loadCopySource(source: ProjectImportSource): Promise<LoadedCopySource> {
  if (source.sourceKind === "directory") {
    const directory = new Directory(source.canonicalLocator!);
    if (!directory.exists) {
      throw new Error("Original directory is unavailable, moved, or its permission was lost");
    }
    const scanned = await scanMobileDirectory(directory);
    return { ...scanned, directory };
  }

  const archiveFile = new File(source.canonicalLocator!);
  if (!archiveFile.exists) {
    throw new Error("Original archive is unavailable, moved, or its permission was lost");
  }
  const archive = await inspectZipArchive(await archiveFile.bytes());
  return {
    snapshot: archive.snapshot,
    bytes: archive.expandedBytes,
    manifest: archive.manifest,
    archiveFile,
    archive,
  };
}

function entrySignature(entry: MobileImportManifestEntry): string {
  return `${entry.type}:${entry.size ?? ""}:${entry.digest ?? ""}`;
}

export function diffCopySourceManifests(
  current: readonly MobileImportManifestEntry[],
  desired: readonly MobileImportManifestEntry[]
): CopySourceChange[] {
  const currentByPath = new Map(current.map((entry) => [entry.path, entry]));
  const desiredByPath = new Map(desired.map((entry) => [entry.path, entry]));
  const paths = [...new Set([...currentByPath.keys(), ...desiredByPath.keys()])].sort();
  const changes: CopySourceChange[] = [];
  for (const path of paths) {
    const before = currentByPath.get(path);
    const after = desiredByPath.get(path);
    if (!before && after) changes.push({ path, status: "A", type: after.type });
    else if (before && !after) changes.push({ path, status: "D", type: before.type });
    else if (before && after && entrySignature(before) !== entrySignature(after)) {
      changes.push({ path, status: "M", type: after.type });
    }
  }
  return changes;
}

async function loadPreview(
  project: Project,
  handle: WorkspaceHandle,
  direction: CopySourceDirection
): Promise<{ preview: CopySourcePreview; source: LoadedCopySource }> {
  const importSource = assertCopyProject(project, handle);
  const source = await loadCopySource(importSource);
  const workspace = await scanMobileDirectory(new Directory(handle.worktreeRoot));
  const decision = classifyCopySourceReconciliation({
    importedSnapshot: importSource.importedSnapshot,
    workspaceSnapshot: workspace.snapshot,
    sourceSnapshot: source.snapshot,
  });
  return {
    source,
    preview: {
      direction,
      decision,
      importedSnapshot: importSource.importedSnapshot,
      workspaceSnapshot: workspace.snapshot,
      sourceSnapshot: source.snapshot,
      changes:
        direction === "reimport"
          ? diffCopySourceManifests(workspace.manifest, source.manifest)
          : diffCopySourceManifests(source.manifest, workspace.manifest),
    },
  };
}

export async function previewCopySourceOperation(
  project: Project,
  handle: WorkspaceHandle,
  direction: CopySourceDirection
): Promise<CopySourcePreview> {
  return (await loadPreview(project, handle, direction)).preview;
}

function clearDirectoryContents(directory: Directory): void {
  if (!directory.exists) return;
  for (const entry of directory.list()) entry.delete();
}

async function writeDirectoryAsZip(directory: Directory, target: File): Promise<void> {
  const entries: Record<string, Uint8Array> = {};
  const visit = async (current: Directory, prefix: string): Promise<void> => {
    const children = current.list();
    if (children.length === 0 && prefix) entries[`${prefix}/`] = new Uint8Array();
    for (const child of children) {
      const path = prefix ? `${prefix}/${child.name}` : child.name;
      if (child instanceof Directory) await visit(child, path);
      else entries[path] = await child.bytes();
    }
  };
  await visit(directory, "");
  target.write(zipSync(entries));
}

function updatedSource(source: ProjectImportSource, snapshot: string): ProjectImportSource {
  return {
    ...source,
    identity: refreshSourceIdentityContent(source.identity, snapshot),
    importedSnapshot: snapshot,
    importedAt: Date.now(),
  };
}

function assertDirectionAllowed(preview: CopySourcePreview, force: boolean): void {
  if (force || preview.decision === "unchanged" || preview.decision === "converged") return;
  if (preview.direction === "reimport" && preview.decision === "source-ahead") return;
  if (preview.direction === "write-back" && preview.decision === "workspace-ahead") return;
  throw new Error(
    preview.decision === "conflict"
      ? "Both the managed copy and original source changed; explicit overwrite confirmation is required"
      : preview.direction === "reimport"
        ? "The managed copy changed while the source did not; reimport would overwrite local work"
        : "The source changed while the managed copy did not; write-back would overwrite source changes"
  );
}

export async function applyCopySourceOperation(args: {
  project: Project;
  handle: WorkspaceHandle;
  direction: CopySourceDirection;
  force?: boolean;
  persistImportSource(source: ProjectImportSource): Promise<void>;
}): Promise<CopySourcePreview> {
  const importSource = assertCopyProject(args.project, args.handle);
  const { preview, source } = await loadPreview(args.project, args.handle, args.direction);
  assertDirectionAllowed(preview, !!args.force);
  if (preview.changes.length === 0) {
    if (preview.decision === "converged") {
      await args.persistImportSource(updatedSource(importSource, preview.workspaceSnapshot));
    }
    return preview;
  }

  const transactionId = randomUUID().replace(/-/g, "");
  const backup = new Directory(getMobileV2Root(), "trash", `source_sync_${transactionId}`);
  const backupUri = backup.uri;
  const workspace = new Directory(args.handle.worktreeRoot);

  if (args.direction === "reimport") {
    assertMobileImportSpace(source.bytes);
    const staging = createMobileImportStagingDirectory();
    const stagingUri = staging.uri;
    try {
      if (source.directory) copyMobileDirectoryContents(source.directory, staging);
      else if (source.archive) writeArchiveToDirectory(source.archive, staging);
      else throw new Error("Copy source could not be staged");
      const staged = await scanMobileDirectory(staging);
      if (staged.snapshot !== source.snapshot)
        throw new Error("Reimport staging verification failed");
      if (backup.exists) backup.delete();
      if (workspace.exists) workspace.move(backup);
      try {
        staging.move(new Directory(args.handle.worktreeRoot));
        const applied = await scanMobileDirectory(new Directory(args.handle.worktreeRoot));
        if (applied.snapshot !== source.snapshot)
          throw new Error("Reimport apply verification failed");
        await args.persistImportSource(updatedSource(importSource, source.snapshot));
      } catch (error) {
        const failedWorkspace = new Directory(args.handle.worktreeRoot);
        if (failedWorkspace.exists) failedWorkspace.delete();
        const rollback = new Directory(backupUri);
        if (rollback.exists) rollback.move(new Directory(args.handle.worktreeRoot));
        throw error;
      }
      const finishedBackup = new Directory(backupUri);
      if (finishedBackup.exists) finishedBackup.delete();
      return preview;
    } finally {
      const remaining = new Directory(stagingUri);
      if (remaining.exists) remaining.delete();
    }
  }

  if (!workspace.exists) throw new Error("Managed workspace is unavailable");
  if (!backup.exists) backup.create({ intermediates: true });
  try {
    if (source.directory) {
      copyMobileDirectoryContents(source.directory, backup);
      clearDirectoryContents(source.directory);
      copyMobileDirectoryContents(workspace, source.directory);
      const written = await scanMobileDirectory(source.directory);
      if (written.snapshot !== preview.workspaceSnapshot) {
        throw new Error("Source write-back verification failed");
      }
    } else if (source.archiveFile) {
      const original = new File(backup, "source.zip");
      original.write(await source.archiveFile.bytes());
      await writeDirectoryAsZip(workspace, source.archiveFile);
      const written = await inspectZipArchive(await source.archiveFile.bytes());
      if (written.snapshot !== preview.workspaceSnapshot) {
        throw new Error("Archive write-back verification failed");
      }
    } else {
      throw new Error("Copy source is unavailable");
    }
    await args.persistImportSource(updatedSource(importSource, preview.workspaceSnapshot));
    if (backup.exists) backup.delete();
    return preview;
  } catch (error) {
    if (source.directory) {
      clearDirectoryContents(source.directory);
      const rollback = new Directory(backupUri);
      if (rollback.exists) copyMobileDirectoryContents(rollback, source.directory);
    } else if (source.archiveFile) {
      const original = new File(new Directory(backupUri), "source.zip");
      if (original.exists) source.archiveFile.write(await original.bytes());
    }
    const remaining = new Directory(backupUri);
    if (remaining.exists) remaining.delete();
    throw error;
  }
}
