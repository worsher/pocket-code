import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createReplicaId,
  createStorageKey,
  getManagedWorkspaceRelativeRoots,
  parseLegacyProjectId,
  parseProjectId,
  parseReplicaId,
  parseStorageKey,
} from "@pocket-code/workspace-core";
import {
  commitLegacyWorkspaceMigration,
  getWorkspaceProject,
  type WorkspaceProjectRecord,
} from "./db.js";
import { ensureServerStorageLayout, getServerV2Root, getWorkspaceRoot } from "./tools.js";
import {
  cleanupLegacyWorkspaceCredentials,
  isGeneratedLegacyWorkspaceCredential,
} from "./gitCredentials.js";
import { isLegacyCredentialArtifact } from "./sensitiveWorkspacePath.js";

const MAX_MIGRATION_ENTRIES = 100_000;

export interface ServerWorkspaceMigrationJournal {
  version: 1;
  transactionId: string;
  userId: string;
  legacyProjectId: string;
  sourceRoot: string;
  projectId: string;
  replicaId: string;
  storageKey: string;
  displayName: string;
  expectedSnapshot: string;
  phase: "prepared" | "verified" | "applied" | "committed";
  startedAt: number;
  updatedAt: number;
  legacyCleanedAt?: number;
}

interface SnapshotEntry {
  path: string;
  type: "directory" | "file";
  size?: number;
  digest?: string;
}

function migrationDirectory(): string {
  const directory = join(ensureServerStorageLayout(), "catalog", "migrations");
  return directory;
}

function migrationFile(userId: string, projectId: string): string {
  const key = createHash("sha256").update(`${userId}\0${projectId}`).digest("hex");
  return join(migrationDirectory(), `server_${key}.json`);
}

async function writeJournal(file: string, journal: ServerWorkspaceMigrationJournal): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.tmp_${process.pid}_${Date.now()}`;
  await writeFile(temporary, JSON.stringify(journal), { mode: 0o600 });
  await rename(temporary, file);
}

function validateJournal(
  value: unknown,
  expected: { userId: string; projectId: string; legacyProjectId: string; sourceRoot: string }
): ServerWorkspaceMigrationJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid workspace migration journal");
  }
  const journal = value as ServerWorkspaceMigrationJournal;
  parseProjectId(journal.projectId);
  parseReplicaId(journal.replicaId);
  parseStorageKey(journal.storageKey);
  parseLegacyProjectId(journal.legacyProjectId);
  if (
    journal.version !== 1 ||
    !journal.transactionId ||
    journal.userId !== expected.userId ||
    journal.projectId !== expected.projectId ||
    journal.legacyProjectId !== expected.legacyProjectId ||
    journal.sourceRoot !== expected.sourceRoot ||
    !/^[0-9a-f]{64}$/.test(journal.expectedSnapshot) ||
    !["prepared", "verified", "applied", "committed"].includes(journal.phase)
  ) {
    throw new Error("Workspace migration journal does not match the requested project");
  }
  return journal;
}

async function readJournal(
  file: string,
  expected: { userId: string; projectId: string; legacyProjectId: string; sourceRoot: string }
): Promise<ServerWorkspaceMigrationJournal | null> {
  if (!existsSync(file)) return null;
  return validateJournal(JSON.parse(await readFile(file, "utf8")), expected);
}

export async function snapshotServerDirectory(root: string): Promise<string> {
  const manifest: SnapshotEntry[] = [];
  let entryCount = 0;
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    );
    if (entries.length === 0 && prefix) manifest.push({ path: prefix, type: "directory" });
    for (const entry of entries) {
      if (
        !prefix &&
        isLegacyCredentialArtifact(entry.name) &&
        (await isGeneratedLegacyWorkspaceCredential(root, entry.name))
      ) {
        continue;
      }
      entryCount++;
      if (entryCount > MAX_MIGRATION_ENTRIES) {
        throw new Error(`Legacy workspace contains more than ${MAX_MIGRATION_ENTRIES} entries`);
      }
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Legacy workspace migration does not copy symbolic links: ${relativePath}`);
      }
      if (metadata.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (metadata.isFile()) {
        const content = await readFile(absolutePath);
        manifest.push({
          path: relativePath,
          type: "file",
          size: content.byteLength,
          digest: createHash("md5").update(content).digest("hex"),
        });
      } else {
        throw new Error(`Unsupported legacy workspace entry: ${relativePath}`);
      }
    }
  };
  await visit(root, "");
  manifest.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

export async function migrateLegacyServerWorkspace(args: {
  userId: string;
  legacyProjectId: string;
  projectId: string;
  displayName?: string;
}): Promise<WorkspaceProjectRecord | null> {
  const legacyProjectId = parseLegacyProjectId(args.legacyProjectId);
  const projectId = parseProjectId(args.projectId);
  const sourceRoot = getWorkspaceRoot({ sessionId: "migration", projectId: legacyProjectId });
  const expected = { userId: args.userId, projectId, legacyProjectId, sourceRoot };
  const file = migrationFile(args.userId, projectId);
  let journal = await readJournal(file, expected);

  if (!journal) {
    if (!existsSync(sourceRoot)) return null;
    const sourceMetadata = await lstat(sourceRoot);
    if (!sourceMetadata.isDirectory()) throw new Error("Legacy workspace root is not a directory");
    const now = Date.now();
    journal = {
      version: 1,
      transactionId: randomUUID().replaceAll("-", ""),
      userId: args.userId,
      legacyProjectId,
      sourceRoot,
      projectId,
      replicaId: createReplicaId(randomUUID),
      storageKey: createStorageKey(randomUUID),
      displayName: args.displayName?.trim().slice(0, 256) ?? "",
      expectedSnapshot: await snapshotServerDirectory(sourceRoot),
      phase: "prepared",
      startedAt: now,
      updatedAt: now,
    };
    await writeJournal(file, journal);
  }

  const roots = getManagedWorkspaceRelativeRoots(journal.storageKey);
  const v2Root = getServerV2Root();
  const projectRoot = join(v2Root, roots.projectRoot);
  const targetWorktree = join(v2Root, roots.worktreeRoot);
  const staging = join(v2Root, "staging", `migration_${journal.transactionId}`);

  if (journal.phase === "prepared") {
    if (!existsSync(sourceRoot)) {
      throw new Error("Legacy workspace is missing; the migration remains resumable");
    }
    await rm(staging, { recursive: true, force: true });
    await cp(sourceRoot, staging, { recursive: true, force: false, errorOnExist: true });
    await cleanupLegacyWorkspaceCredentials(staging);
    const stagedSnapshot = await snapshotServerDirectory(staging);
    if (stagedSnapshot !== journal.expectedSnapshot) {
      await rm(staging, { recursive: true, force: true });
      throw new Error("Legacy workspace changed during migration; retry without deleting it");
    }
    journal = { ...journal, phase: "verified", updatedAt: Date.now() };
    await writeJournal(file, journal);
  }

  if (journal.phase === "verified") {
    if (existsSync(targetWorktree)) {
      await cleanupLegacyWorkspaceCredentials(targetWorktree);
      if ((await snapshotServerDirectory(targetWorktree)) !== journal.expectedSnapshot) {
        throw new Error("Migration target already exists with different content");
      }
      await rm(staging, { recursive: true, force: true });
    } else {
      if (!existsSync(staging)) throw new Error("Verified migration staging is unavailable");
      await mkdir(projectRoot, { recursive: true });
      await rename(staging, targetWorktree);
    }
    await cleanupLegacyWorkspaceCredentials(targetWorktree);
    await Promise.all([
      mkdir(join(v2Root, roots.stateRoot), { recursive: true }),
      mkdir(join(v2Root, roots.cacheRoot), { recursive: true }),
    ]);
    if ((await snapshotServerDirectory(targetWorktree)) !== journal.expectedSnapshot) {
      throw new Error("Migrated workspace failed final snapshot verification");
    }
    journal = { ...journal, phase: "applied", updatedAt: Date.now() };
    await writeJournal(file, journal);
  }

  if (journal.phase === "applied") {
    const committed = commitLegacyWorkspaceMigration({
      userId: journal.userId,
      legacyProjectId: journal.legacyProjectId,
      projectId: journal.projectId,
      replicaId: journal.replicaId,
      storageKey: journal.storageKey,
      displayName: journal.displayName,
    });
    journal = { ...journal, phase: "committed", updatedAt: Date.now() };
    await writeJournal(file, journal);
    return committed;
  }

  return getWorkspaceProject(args.userId, projectId);
}

/** Deletes one exact legacy server root only after an explicit authenticated request. */
export async function cleanupLegacyServerWorkspace(args: {
  userId: string;
  legacyProjectId: string;
  projectId: string;
}): Promise<boolean> {
  const legacyProjectId = parseLegacyProjectId(args.legacyProjectId);
  const projectId = parseProjectId(args.projectId);
  const sourceRoot = getWorkspaceRoot({ sessionId: "cleanup", projectId: legacyProjectId });
  const file = migrationFile(args.userId, projectId);
  const journal = await readJournal(file, {
    userId: args.userId,
    projectId,
    legacyProjectId,
    sourceRoot,
  });
  if (!journal || journal.phase !== "committed") return false;
  if (journal.legacyCleanedAt) return false;
  await rm(sourceRoot, { recursive: true, force: true });
  const now = Date.now();
  await writeJournal(file, { ...journal, legacyCleanedAt: now, updatedAt: now });
  return true;
}
