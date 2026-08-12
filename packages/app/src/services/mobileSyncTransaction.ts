import { Directory, File } from "expo-file-system";
import { CryptoDigestAlgorithm, digestStringAsync, randomUUID } from "expo-crypto";
import {
  createSyncTransactionJournal,
  normalizeWorkspaceRelativePath,
  runSyncTransaction,
  type SyncTransactionJournal,
  type WorkspaceHandle,
} from "@pocket-code/workspace-core";
import type { ProjectSyncEdge, RemoteReplicaCatalogEntry } from "../store/projectCatalog";
import { deleteLocalFile, writeLocalFileBase64 } from "./localFileSystem";
import { getMobileV2Root } from "./workspaceResolver";
import { recordWorkspaceMetric } from "./workspaceTelemetry";
import { isSensitiveGitContentPath } from "./gitSensitivePath";

const SYNC_IGNORED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".cache",
  ".expo",
  ".turbo",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
]);
const SYNC_BLOCKED_CREDENTIAL_FILES = new Set([".git-credentials", ".gitconfig", ".netrc"]);

export interface MobileSyncManifestFile {
  path: string;
  status: "A" | "M" | "D";
  size?: number;
  digest?: string;
}

export interface MobileSyncManifest {
  commit: string;
  snapshot: string;
  parent: string | null;
  full: boolean;
  files: MobileSyncManifestFile[];
}

export interface MobileSyncFileContent {
  path: string;
  content?: string;
  encoding?: string;
  error?: string;
}

interface SyncManifestEntry {
  path: string;
  size: number;
  digest: string;
}

interface StoredMobileSyncJournal {
  journal: SyncTransactionJournal;
  manifest: MobileSyncManifest;
}

export interface MobilePullTransactionDeps {
  workspaceHandle: WorkspaceHandle;
  remoteReplica: RemoteReplicaCatalogEntry;
  edge?: ProjectSyncEdge;
  legacyRemoteRef?: string | null;
  requestSyncPull(sinceCommit?: string): Promise<MobileSyncManifest>;
  requestSyncFile(commit: string, path: string): Promise<MobileSyncFileContent>;
  persistEdge(edge: ProjectSyncEdge): Promise<void>;
  forceRemote?: boolean;
  conflictResolution?: "keep-local" | "keep-remote" | "save-copy";
  onProgress?: (message: string) => void;
}

export interface MobilePullTransactionResult {
  success: boolean;
  commit?: string;
  applied: number;
  deleted: number;
  failed: string[];
  error?: string;
  conflict?: ProjectSyncEdge["conflict"];
  edge: ProjectSyncEdge;
}

function ensureDirectory(directory: Directory): void {
  if (!directory.exists) directory.create({ idempotent: true, intermediates: true });
}

function shouldIgnoreEntry(name: string, directory: boolean): boolean {
  if (isSensitiveGitContentPath(name)) return true;
  if (directory && SYNC_IGNORED_DIRECTORIES.has(name)) return true;
  return (
    name === ".DS_Store" ||
    name.endsWith(".log") ||
    (!directory && SYNC_BLOCKED_CREDENTIAL_FILES.has(name))
  );
}

export function isBlockedMobileSyncPath(path: string): boolean {
  let normalized: string;
  try {
    normalized = normalizeWorkspaceRelativePath(path);
  } catch {
    return true;
  }
  const segments = normalized.split("/");
  return (
    isSensitiveGitContentPath(normalized) ||
    segments.some((segment) => SYNC_IGNORED_DIRECTORIES.has(segment)) ||
    SYNC_BLOCKED_CREDENTIAL_FILES.has(segments.at(-1) ?? "")
  );
}

export async function scanMobileSyncDirectory(root: Directory): Promise<{
  snapshot: string;
  files: SyncManifestEntry[];
}> {
  const files: SyncManifestEntry[] = [];
  if (!root.exists) {
    const snapshot = await digestStringAsync(CryptoDigestAlgorithm.SHA256, "[]");
    return { snapshot, files };
  }

  const visit = async (directory: Directory, prefix: string): Promise<void> => {
    for (const entry of directory
      .list()
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (entry instanceof Directory) {
        if (!shouldIgnoreEntry(entry.name, true)) {
          await visit(entry, prefix ? `${prefix}/${entry.name}` : entry.name);
        }
        continue;
      }
      if (shouldIgnoreEntry(entry.name, false)) continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const info = entry.info({ md5: true });
      if (!info.exists || !info.md5) throw new Error(`Unable to verify synchronized file: ${path}`);
      files.push({ path, size: info.size ?? entry.size, digest: info.md5.toLowerCase() });
    }
  };

  await visit(root, "");
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const snapshot = await digestStringAsync(CryptoDigestAlgorithm.SHA256, JSON.stringify(files));
  return { snapshot, files };
}

function copyDirectoryContents(source: Directory, destination: Directory): void {
  ensureDirectory(destination);
  if (!source.exists) return;
  for (const entry of source.list()) {
    if (shouldIgnoreEntry(entry.name, entry instanceof Directory)) continue;
    if (entry instanceof Directory) {
      copyDirectoryContents(entry, new Directory(destination, entry.name));
    } else {
      entry.copy(new File(destination, entry.name));
    }
  }
}

function syncStateDirectory(handle: WorkspaceHandle): Directory {
  const directory = new Directory(handle.stateRoot, "sync");
  ensureDirectory(directory);
  return directory;
}

function journalFile(handle: WorkspaceHandle, remoteReplicaId: string): File {
  return new File(syncStateDirectory(handle), `${remoteReplicaId}.journal.json`);
}

function transactionStaging(transactionId: string): Directory {
  return new Directory(getMobileV2Root(), "staging", `sync_${transactionId}`);
}

function transactionBackup(transactionId: string): Directory {
  return new Directory(getMobileV2Root(), "trash", `sync_backup_${transactionId}`);
}

function writeStoredJournal(file: File, value: StoredMobileSyncJournal): void {
  ensureDirectory(file.parentDirectory);
  const temporary = new File(file.parentDirectory, `${file.name}.tmp`);
  if (temporary.exists) temporary.delete();
  temporary.write(JSON.stringify(value));
  if (file.exists) file.delete();
  temporary.move(file);
}

async function readStoredJournal(
  handle: WorkspaceHandle,
  remoteReplicaId: string
): Promise<StoredMobileSyncJournal | null> {
  const file = journalFile(handle, remoteReplicaId);
  if (!file.exists) return null;
  try {
    const parsed = JSON.parse(await file.text()) as StoredMobileSyncJournal;
    if (
      parsed?.journal?.version !== 1 ||
      typeof parsed.journal.transactionId !== "string" ||
      typeof parsed.manifest?.commit !== "string" ||
      typeof parsed.manifest?.snapshot !== "string" ||
      !Array.isArray(parsed.manifest?.files)
    ) {
      throw new Error("invalid journal");
    }
    return parsed;
  } catch {
    const corrupt = new File(file.parentDirectory, `${file.name}.corrupt_${Date.now()}`);
    file.move(corrupt);
    return null;
  }
}

function createEdge(args: {
  handle: WorkspaceHandle;
  remoteReplica: RemoteReplicaCatalogEntry;
  previous?: ProjectSyncEdge;
  baseSnapshot?: string | null;
  localSnapshot: string | null;
  remoteSnapshot: string | null;
  baseRemoteRef?: string | null;
  phase: ProjectSyncEdge["phase"];
  transactionId?: string;
  conflict?: ProjectSyncEdge["conflict"];
}): ProjectSyncEdge {
  return {
    localReplicaId: args.handle.replicaId,
    remoteReplicaId: args.remoteReplica.id,
    remoteAuthorityId: args.remoteReplica.authorityId,
    baseSnapshot:
      args.baseSnapshot === undefined ? (args.previous?.baseSnapshot ?? null) : args.baseSnapshot,
    localSnapshot: args.localSnapshot,
    remoteSnapshot: args.remoteSnapshot,
    baseRemoteRef:
      args.baseRemoteRef === undefined
        ? (args.previous?.baseRemoteRef ?? null)
        : args.baseRemoteRef,
    phase: args.phase,
    transactionId: args.transactionId,
    conflict: args.conflict,
    updatedAt: Date.now(),
  };
}

async function removeFullSyncStaleFiles(
  staging: Directory,
  manifest: MobileSyncManifest
): Promise<void> {
  const remotePaths = new Set(
    manifest.files.filter((file) => file.status !== "D").map((file) => file.path)
  );
  const local = await scanMobileSyncDirectory(staging);
  for (const file of local.files) {
    if (!remotePaths.has(file.path)) {
      const result = await deleteLocalFile(file.path, staging.uri);
      if (!result.success) throw new Error(result.error ?? `Unable to remove ${file.path}`);
    }
  }
}

function validateManifest(manifest: MobileSyncManifest): MobileSyncManifest {
  if (!/^[0-9a-f]{40,64}$/i.test(manifest.commit)) throw new Error("Invalid remote sync commit");
  if (!/^[0-9a-f]{64}$/i.test(manifest.snapshot)) throw new Error("Invalid remote sync snapshot");
  const seen = new Set<string>();
  const files = manifest.files.map((file) => {
    const path = normalizeWorkspaceRelativePath(file.path);
    if (path === "." || seen.has(path)) throw new Error(`Invalid duplicate sync path: ${path}`);
    if (isBlockedMobileSyncPath(path)) {
      throw new Error(`Remote sync manifest contains a blocked credential path: ${path}`);
    }
    seen.add(path);
    if (file.status !== "D" && !/^[0-9a-f]{32}$/i.test(file.digest ?? "")) {
      throw new Error(`Missing transfer digest for ${path}`);
    }
    return { ...file, path, digest: file.digest?.toLowerCase() };
  });
  return { ...manifest, snapshot: manifest.snapshot.toLowerCase(), files };
}

async function recoverJournalIfNeeded(
  stored: StoredMobileSyncJournal,
  handle: WorkspaceHandle
): Promise<StoredMobileSyncJournal> {
  const { journal } = stored;
  if (journal.phase !== "recovery-required" && journal.phase !== "applying") return stored;
  const worktree = new Directory(handle.worktreeRoot);
  const staging = transactionStaging(journal.transactionId);
  const backup = transactionBackup(journal.transactionId);
  const current = await scanMobileSyncDirectory(worktree);
  if (current.snapshot === journal.expectedSnapshot) {
    await recordWorkspaceMetric("recovery-succeeded").catch(() => undefined);
    return {
      ...stored,
      journal: {
        ...journal,
        phase: "committed",
        verifiedSnapshot: journal.expectedSnapshot,
        appliedSnapshot: journal.expectedSnapshot,
        error: undefined,
      },
    };
  }
  if (!worktree.exists && staging.exists) {
    staging.move(worktree);
    const applied = await scanMobileSyncDirectory(worktree);
    if (applied.snapshot === journal.expectedSnapshot) {
      await recordWorkspaceMetric("recovery-succeeded").catch(() => undefined);
      return {
        ...stored,
        journal: {
          ...journal,
          phase: "committed",
          verifiedSnapshot: journal.expectedSnapshot,
          appliedSnapshot: journal.expectedSnapshot,
          error: undefined,
        },
      };
    }
  }
  if (!worktree.exists && backup.exists) backup.move(worktree);
  throw new Error("Unable to recover interrupted workspace apply; original copy was restored");
}

export async function pullMobileReplicaTransaction(
  deps: MobilePullTransactionDeps
): Promise<MobilePullTransactionResult> {
  const { workspaceHandle: handle, remoteReplica, onProgress } = deps;
  const worktree = new Directory(handle.worktreeRoot);
  ensureDirectory(worktree);
  let existingStored = await readStoredJournal(handle, remoteReplica.id);
  if (existingStored) {
    const needsRecovery = ["recovery-required", "applying"].includes(existingStored.journal.phase);
    if (needsRecovery) {
      await recordWorkspaceMetric("recovery-attempted").catch(() => undefined);
    }
    existingStored = await recoverJournalIfNeeded(existingStored, handle);
  }

  const localBefore = await scanMobileSyncDirectory(worktree);
  let manifest: MobileSyncManifest;
  let journal: SyncTransactionJournal;
  if (existingStored && existingStored.journal.phase === "committed") {
    manifest = validateManifest(existingStored.manifest);
    journal = existingStored.journal;
  } else {
    if (existingStored) {
      const oldStaging = transactionStaging(existingStored.journal.transactionId);
      const oldBackup = transactionBackup(existingStored.journal.transactionId);
      if (oldStaging.exists) oldStaging.delete();
      if (oldBackup.exists) oldBackup.delete();
      const oldJournal = journalFile(handle, remoteReplica.id);
      if (oldJournal.exists) oldJournal.delete();
    }
    const incrementalRef = deps.forceRemote
      ? undefined
      : (deps.edge?.baseRemoteRef ?? deps.legacyRemoteRef ?? undefined);
    onProgress?.("正在准备远端快照...");
    manifest = validateManifest(await deps.requestSyncPull(incrementalRef));

    const previousBase = deps.edge?.baseSnapshot ?? null;
    const migratedLegacyBase = !previousBase && deps.legacyRemoteRef && !manifest.full;
    const effectiveBase = migratedLegacyBase ? localBefore.snapshot : previousBase;
    const localChanged = effectiveBase
      ? localBefore.snapshot !== effectiveBase
      : localBefore.files.length > 0;
    const remoteChanged = effectiveBase ? manifest.snapshot !== effectiveBase : true;

    if (localBefore.snapshot === manifest.snapshot) {
      const edge = createEdge({
        handle,
        remoteReplica,
        previous: deps.edge,
        baseSnapshot: manifest.snapshot,
        localSnapshot: manifest.snapshot,
        remoteSnapshot: manifest.snapshot,
        baseRemoteRef: manifest.commit,
        phase: "committed",
      });
      await deps.persistEdge(edge);
      return { success: true, commit: manifest.commit, applied: 0, deleted: 0, failed: [], edge };
    }

    if (!deps.forceRemote && localChanged && (remoteChanged || !!effectiveBase)) {
      await recordWorkspaceMetric("directory-conflict").catch(() => undefined);
      const conflict = {
        baseSnapshot: effectiveBase,
        localSnapshot: localBefore.snapshot,
        remoteSnapshot: manifest.snapshot,
        detectedAt: Date.now(),
        resolution: deps.conflictResolution,
      } satisfies NonNullable<ProjectSyncEdge["conflict"]>;
      const edge = createEdge({
        handle,
        remoteReplica,
        previous: deps.edge,
        baseSnapshot: effectiveBase,
        localSnapshot: localBefore.snapshot,
        remoteSnapshot: manifest.snapshot,
        phase: "conflict",
        conflict,
      });
      await deps.persistEdge(edge);
      return { success: false, applied: 0, deleted: 0, failed: [], conflict, edge };
    }

    journal = createSyncTransactionJournal({
      transactionId: randomUUID(),
      edgeId: `${handle.replicaId}:${remoteReplica.id}`,
      baseSnapshot: effectiveBase,
      expectedSnapshot: manifest.snapshot,
    });
  }

  const staging = transactionStaging(journal.transactionId);
  const backup = transactionBackup(journal.transactionId);
  const stagingUri = staging.uri;
  const backupUri = backup.uri;
  const journalPath = journalFile(handle, remoteReplica.id);
  const changed = manifest.files.filter((file) => file.status !== "D").length;
  const deleted = manifest.files.filter((file) => file.status === "D").length;
  let transferred = 0;

  const committed = await runSyncTransaction(journal, {
    async persistJournal(next) {
      writeStoredJournal(journalPath, { journal: next, manifest });
      await deps.persistEdge(
        createEdge({
          handle,
          remoteReplica,
          previous: deps.edge,
          localSnapshot: localBefore.snapshot,
          remoteSnapshot: manifest.snapshot,
          phase: next.phase,
          transactionId: next.transactionId,
        })
      );
    },
    async prepare() {
      onProgress?.("正在创建事务副本...");
      if (staging.exists) staging.delete();
      copyDirectoryContents(worktree, staging);
    },
    async transfer() {
      if (manifest.full) await removeFullSyncStaleFiles(staging, manifest);
      for (let index = 0; index < manifest.files.length; index++) {
        const file = manifest.files[index];
        onProgress?.(`正在传输 (${index + 1}/${manifest.files.length}): ${file.path}`);
        if (file.status === "D") {
          const result = await deleteLocalFile(file.path, staging.uri);
          if (!result.success) throw new Error(result.error ?? `Unable to delete ${file.path}`);
          continue;
        }
        const remote = await deps.requestSyncFile(manifest.commit, file.path);
        if (remote.error || typeof remote.content !== "string") {
          throw new Error(remote.error ?? `Unable to download ${file.path}`);
        }
        const result = await writeLocalFileBase64(file.path, remote.content, staging.uri);
        if (!result.success) throw new Error(result.error ?? `Unable to write ${file.path}`);
        transferred++;
      }
    },
    async verify() {
      onProgress?.("正在校验事务副本...");
      const scanned = await scanMobileSyncDirectory(staging);
      const byPath = new Map(scanned.files.map((file) => [file.path, file]));
      for (const file of manifest.files) {
        const actual = byPath.get(file.path);
        if (file.status === "D") {
          if (actual) throw new Error(`Deleted file still exists: ${file.path}`);
        } else if (!actual || actual.digest !== file.digest || actual.size !== file.size) {
          throw new Error(`Transferred file failed integrity check: ${file.path}`);
        }
      }
      return scanned.snapshot;
    },
    async apply() {
      onProgress?.("正在原子应用同步结果...");
      const currentWorktree = new Directory(handle.worktreeRoot);
      const current = await scanMobileSyncDirectory(currentWorktree);
      if (current.snapshot === manifest.snapshot) return current.snapshot;
      if (backup.exists) backup.delete();
      if (currentWorktree.exists) currentWorktree.move(backup);
      try {
        staging.move(new Directory(handle.worktreeRoot));
      } catch (error) {
        const restoredWorktree = new Directory(handle.worktreeRoot);
        if (!restoredWorktree.exists && backup.exists) backup.move(restoredWorktree);
        throw error;
      }
      return (await scanMobileSyncDirectory(new Directory(handle.worktreeRoot))).snapshot;
    },
    async commit(next) {
      await deps.persistEdge(
        createEdge({
          handle,
          remoteReplica,
          previous: deps.edge,
          baseSnapshot: next.expectedSnapshot,
          localSnapshot: next.expectedSnapshot,
          remoteSnapshot: next.expectedSnapshot,
          baseRemoteRef: manifest.commit,
          phase: "committed",
        })
      );
    },
    async cleanup() {
      const remainingStaging = new Directory(stagingUri);
      const remainingBackup = new Directory(backupUri);
      if (remainingStaging.exists) remainingStaging.delete();
      if (remainingBackup.exists) remainingBackup.delete();
      if (journalPath.exists) journalPath.delete();
    },
  });

  const edge = createEdge({
    handle,
    remoteReplica,
    previous: deps.edge,
    baseSnapshot: committed.expectedSnapshot,
    localSnapshot: committed.expectedSnapshot,
    remoteSnapshot: committed.expectedSnapshot,
    baseRemoteRef: manifest.commit,
    phase: "committed",
  });
  return {
    success: true,
    commit: manifest.commit,
    applied: Math.max(changed, transferred),
    deleted,
    failed: [],
    edge,
  };
}

export function cloneMobileWorkspace(source: WorkspaceHandle, destination: WorkspaceHandle): void {
  const target = new Directory(destination.worktreeRoot);
  if (target.exists) target.delete();
  copyDirectoryContents(new Directory(source.worktreeRoot), target);
}
