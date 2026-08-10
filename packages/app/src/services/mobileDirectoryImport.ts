import { Directory, File, Paths } from "expo-file-system";
import { CryptoDigestAlgorithm, digestStringAsync, randomUUID } from "expo-crypto";
import {
  runImportPipeline,
  type ExistingImportSource,
  type ImportPipelineResult,
  type ImportProbe,
  type SourceIdentity,
} from "@pocket-code/workspace-core";
import { createImportedProject, type Project } from "../store/projects";
import {
  ensureMobileStorageLayout,
  ensureMobileWorkspaceHandle,
  getMobileV2Root,
} from "./workspaceResolver";

export const MIN_FREE_SPACE_BUFFER = 16 * 1024 * 1024;
export const MAX_IMPORT_FILES = 100_000;

export interface MobileImportManifestEntry {
  path: string;
  type: "directory" | "file";
  size?: number;
  digest?: string;
}

export interface MobileDirectoryProbe extends ImportProbe {
  readonly importMode: "copy";
  readonly sourceKind: "directory";
  readonly source: Directory;
}

export interface MobileStagedImport {
  stagedSnapshot: string;
  directory: Directory;
  committedProjectRoot?: Directory;
}

export type MobileDirectoryImportResult = ImportPipelineResult<MobileDirectoryProbe, Project>;

export async function scanMobileDirectory(root: Directory): Promise<{
  snapshot: string;
  bytes: number;
  fileCount: number;
  manifest: MobileImportManifestEntry[];
}> {
  const manifest: MobileImportManifestEntry[] = [];
  let bytes = 0;
  let fileCount = 0;
  let entryCount = 0;

  const visit = async (directory: Directory, prefix: string): Promise<void> => {
    const entries = directory.list().sort((a, b) => a.name.localeCompare(b.name));
    if (entries.length === 0 && prefix) manifest.push({ path: prefix, type: "directory" });
    for (const entry of entries) {
      entryCount++;
      if (entryCount > MAX_IMPORT_FILES) {
        throw new Error(`Directory contains more than ${MAX_IMPORT_FILES} entries`);
      }
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry instanceof Directory) {
        await visit(entry, path);
        continue;
      }
      fileCount++;
      if (fileCount > MAX_IMPORT_FILES) {
        throw new Error(`Directory contains more than ${MAX_IMPORT_FILES} files`);
      }
      const info = entry.info({ md5: true });
      if (!info.exists || !info.md5) throw new Error(`Unable to fingerprint source file: ${path}`);
      const size = info.size ?? entry.size;
      bytes += size;
      manifest.push({ path, type: "file", size, digest: info.md5.toLowerCase() });
    }
  };

  await visit(root, "");
  manifest.sort((a, b) => a.path.localeCompare(b.path));
  const snapshot = await digestStringAsync(CryptoDigestAlgorithm.SHA256, JSON.stringify(manifest));
  return { snapshot, bytes, fileCount, manifest };
}

export function assertMobileImportSpace(estimatedBytes: number): void {
  const required =
    estimatedBytes + Math.max(MIN_FREE_SPACE_BUFFER, Math.ceil(estimatedBytes * 0.1));
  if (Paths.availableDiskSpace < required) {
    throw new Error("Not enough free space to import this project safely");
  }
}

export function createMobileImportStagingDirectory(): Directory {
  const root = ensureMobileStorageLayout();
  const staging = new Directory(root, "staging", `import_${randomUUID().replace(/-/g, "")}`);
  staging.create({ intermediates: true });
  return staging;
}

export async function commitManagedMobileImport(args: {
  probe: ImportProbe;
  staged: MobileStagedImport;
  identity: SourceIdentity;
  verifiedSnapshot: string;
  writeBackPolicy: "explicit" | "git";
  gitUrl?: string;
  commitProject(project: Project): Promise<void>;
}): Promise<Project> {
  const project = {
    ...createImportedProject(args.probe.suggestedName, {
      mode: args.probe.importMode,
      sourceKind: args.probe.sourceKind,
      sourceDeviceId: args.probe.sourceDeviceId,
      canonicalLocator: args.probe.canonicalLocator,
      identity: args.identity,
      importedSnapshot: args.verifiedSnapshot,
      importedAt: Date.now(),
      writeBackPolicy: args.writeBackPolicy,
    }),
    ...(args.gitUrl ? { gitUrl: args.gitUrl } : {}),
  };
  const handle = ensureMobileWorkspaceHandle(project);
  const worktree = new Directory(handle.worktreeRoot);
  if (worktree.exists) worktree.delete();
  args.staged.directory.move(worktree);
  args.staged.committedProjectRoot = worktree.parentDirectory;
  await args.commitProject(project);
  return project;
}

export async function rollbackManagedMobileImport(staged: MobileStagedImport): Promise<void> {
  if (staged.committedProjectRoot?.exists) {
    staged.committedProjectRoot.delete();
  } else if (staged.directory.exists) {
    staged.directory.delete();
  }
}

export function copyMobileDirectoryContents(
  source: Directory,
  destination: Directory,
  state: { entries: number } = { entries: 0 }
): void {
  if (!destination.exists) destination.create({ idempotent: true, intermediates: true });
  for (const entry of source.list()) {
    state.entries++;
    if (state.entries > MAX_IMPORT_FILES) {
      throw new Error(`Directory contains more than ${MAX_IMPORT_FILES} entries`);
    }
    if (entry instanceof Directory) {
      copyMobileDirectoryContents(entry, new Directory(destination, entry.name), state);
    } else {
      entry.copy(new File(destination, entry.name));
    }
  }
}

export async function pickMobileProjectDirectory(): Promise<Directory> {
  return (await Directory.pickDirectoryAsync()) as Directory;
}

export function getExistingImportSources(projects: readonly Project[]): ExistingImportSource[] {
  return projects.flatMap((project) =>
    project.importSource ? [{ projectId: project.id, identity: project.importSource.identity }] : []
  );
}

export async function importMobileDirectory(args: {
  source: Directory;
  sourceDeviceId: string;
  projects: readonly Project[];
  allowWeakDuplicate?: boolean;
  commitProject(project: Project): Promise<void>;
}): Promise<MobileDirectoryImportResult> {
  const managedRoot = getMobileV2Root().uri;
  if (args.source.uri === managedRoot || args.source.uri.startsWith(`${managedRoot}/`)) {
    throw new Error("Cannot import a Pocket Code managed directory");
  }

  return runImportPipeline({
    input: args.source,
    existingSources: getExistingImportSources(args.projects),
    allowWeakDuplicate: args.allowWeakDuplicate,
    adapter: {
      async probe(source): Promise<MobileDirectoryProbe> {
        if (!source.exists)
          throw new Error("Selected directory is unavailable or permission was lost");
        const scanned = await scanMobileDirectory(source);
        return {
          importMode: "copy",
          sourceKind: "directory",
          sourceDeviceId: args.sourceDeviceId,
          suggestedName: source.name || "Imported project",
          canonicalLocator: source.uri,
          contentFingerprint: scanned.snapshot,
          sourceSnapshot: scanned.snapshot,
          estimatedBytes: scanned.bytes,
          source,
        };
      },
      async stage(probe): Promise<MobileStagedImport> {
        assertMobileImportSpace(probe.estimatedBytes);
        const staging = createMobileImportStagingDirectory();
        try {
          copyMobileDirectoryContents(probe.source, staging);
          const stagedSnapshot = (await scanMobileDirectory(staging)).snapshot;
          return { directory: staging, stagedSnapshot };
        } catch (error) {
          if (staging.exists) staging.delete();
          throw error;
        }
      },
      async verify(_probe, staged) {
        return (await scanMobileDirectory(staged.directory)).snapshot;
      },
      async commit({ probe, staged, identity, verifiedSnapshot }) {
        return commitManagedMobileImport({
          probe,
          staged,
          identity,
          verifiedSnapshot,
          writeBackPolicy: "explicit",
          commitProject: args.commitProject,
        });
      },
      async rollback(staged) {
        await rollbackManagedMobileImport(staged);
      },
    },
  });
}
