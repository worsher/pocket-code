import { Directory, File, Paths } from "expo-file-system";
import { randomUUID } from "expo-crypto";
import { getManagedWorkspaceRelativeRoots } from "@pocket-code/workspace-core";
import type { Project } from "../store/projects";
import { promoteLegacyProjectToV2 } from "../store/projectCatalog";
import { copyMobileDirectoryContents, scanMobileDirectory } from "./mobileDirectoryImport";
import {
  ensureMobileStorageLayout,
  getLegacyMobileWorkspaceRoot,
  getMobileV2Root,
} from "./workspaceResolver";
import { recordWorkspaceMetric } from "./workspaceTelemetry";

export interface MobileWorkspaceMigrationJournal {
  version: 1;
  transactionId: string;
  legacyProjectId: string;
  sourceRoot: string;
  targetProject: Project;
  expectedSnapshot: string;
  phase: "prepared" | "verified" | "applied" | "committed";
  startedAt: number;
  updatedAt: number;
  legacyCleanedAt?: number;
}

function migrationsDirectory(): Directory {
  const directory = new Directory(ensureMobileStorageLayout(), "catalog", "migrations");
  if (!directory.exists) directory.create({ intermediates: true });
  return directory;
}

function migrationFile(storageKey: string): File {
  return new File(migrationsDirectory(), `mobile_${storageKey}.json`);
}

function writeJournal(file: File, journal: MobileWorkspaceMigrationJournal): void {
  const temporary = new File(file.parentDirectory, `${file.name}.tmp`);
  if (temporary.exists) temporary.delete();
  temporary.write(JSON.stringify(journal));
  if (file.exists) file.delete();
  temporary.move(file);
}

async function readJournal(file: File): Promise<MobileWorkspaceMigrationJournal | null> {
  if (!file.exists) return null;
  try {
    const value = JSON.parse(await file.text()) as MobileWorkspaceMigrationJournal;
    if (
      value.version !== 1 ||
      !value.transactionId ||
      !value.targetProject ||
      value.targetProject.localReplica.layout !== "v2" ||
      !["prepared", "verified", "applied", "committed"].includes(value.phase)
    ) {
      throw new Error("invalid migration journal");
    }
    return value;
  } catch {
    const corrupt = new File(file.parentDirectory, `${file.name}.corrupt_${Date.now()}`);
    file.move(corrupt);
    return null;
  }
}

function directoryFromRelativeRoot(relativeRoot: string): Directory {
  return new Directory(getMobileV2Root(), ...relativeRoot.split("/"));
}

export async function migrateLegacyMobileProject(args: {
  project: Project;
  persistProject(previousProjectId: string, replacement: Project): Promise<void>;
}): Promise<Project> {
  if (args.project.localReplica.layout === "v2") return args.project;
  const source = new Directory(getLegacyMobileWorkspaceRoot(args.project));
  const file = migrationFile(args.project.localReplica.storageKey);
  let journal = await readJournal(file);
  const recovering = !!journal && journal.phase !== "committed";
  if (recovering) {
    await recordWorkspaceMetric("recovery-attempted").catch(() => undefined);
  }
  if (!journal) {
    if (!source.exists) {
      throw new Error("Legacy workspace is missing; the existing catalog entry was left unchanged");
    }
    const scanned = await scanMobileDirectory(source);
    const targetProject = promoteLegacyProjectToV2(args.project, randomUUID);
    const now = Date.now();
    journal = {
      version: 1,
      transactionId: randomUUID().replace(/-/g, ""),
      legacyProjectId: args.project.id,
      sourceRoot: source.uri,
      targetProject,
      expectedSnapshot: scanned.snapshot,
      phase: "prepared",
      startedAt: now,
      updatedAt: now,
    };
    writeJournal(file, journal);
  }

  const roots = getManagedWorkspaceRelativeRoots(journal.targetProject.localReplica.storageKey);
  const projectRoot = directoryFromRelativeRoot(roots.projectRoot);
  const targetWorktree = directoryFromRelativeRoot(roots.worktreeRoot);
  const staging = new Directory(getMobileV2Root(), "staging", `migration_${journal.transactionId}`);

  if (journal.phase === "prepared") {
    if (!source.exists) {
      throw new Error("Legacy workspace is missing; the migration remains resumable");
    }
    if (staging.exists) staging.delete();
    staging.create({ intermediates: true });
    copyMobileDirectoryContents(source, staging);
    const staged = await scanMobileDirectory(staging);
    if (staged.snapshot !== journal.expectedSnapshot) {
      staging.delete();
      throw new Error("Legacy workspace changed during migration; retry without deleting it");
    }
    journal = { ...journal, phase: "verified", updatedAt: Date.now() };
    writeJournal(file, journal);
  }

  if (journal.phase === "verified") {
    if (targetWorktree.exists) {
      const existing = await scanMobileDirectory(targetWorktree);
      if (existing.snapshot !== journal.expectedSnapshot) {
        throw new Error("Migration target already exists with different content");
      }
    } else {
      if (!staging.exists) throw new Error("Verified migration staging is unavailable");
      if (!projectRoot.exists) projectRoot.create({ intermediates: true });
      staging.move(targetWorktree);
    }
    for (const root of [roots.stateRoot, roots.cacheRoot]) {
      const directory = directoryFromRelativeRoot(root);
      if (!directory.exists) directory.create({ intermediates: true });
    }
    const applied = await scanMobileDirectory(targetWorktree);
    if (applied.snapshot !== journal.expectedSnapshot) {
      throw new Error("Migrated workspace failed final snapshot verification");
    }
    journal = { ...journal, phase: "applied", updatedAt: Date.now() };
    writeJournal(file, journal);
  }

  if (journal.phase === "applied") {
    await args.persistProject(args.project.id, journal.targetProject);
    journal = { ...journal, phase: "committed", updatedAt: Date.now() };
    writeJournal(file, journal);
  }

  if (recovering) await recordWorkspaceMetric("recovery-succeeded").catch(() => undefined);
  return journal.targetProject;
}

export async function listMobileWorkspaceMigrations(): Promise<MobileWorkspaceMigrationJournal[]> {
  const directory = migrationsDirectory();
  const journals: MobileWorkspaceMigrationJournal[] = [];
  for (const entry of directory.list()) {
    if (!(entry instanceof File) || !entry.name.endsWith(".json")) continue;
    const journal = await readJournal(entry);
    if (journal) journals.push(journal);
  }
  return journals;
}

/**
 * Repairs the narrow crash window where the catalog write succeeded but the
 * journal's final phase write did not. No filesystem content is changed.
 */
export async function reconcileMobileWorkspaceMigrations(
  projects: readonly Project[]
): Promise<number> {
  const journals = await listMobileWorkspaceMigrations();
  let recovered = 0;
  for (const journal of journals) {
    if (journal.phase !== "applied") continue;
    const catalogProject = projects.find(
      (project) =>
        project.id === journal.targetProject.id &&
        project.localReplica.layout === "v2" &&
        project.localReplica.storageKey === journal.targetProject.localReplica.storageKey
    );
    if (!catalogProject) continue;
    const now = Date.now();
    writeJournal(migrationFile(catalogProject.localReplica.storageKey), {
      ...journal,
      targetProject: catalogProject,
      phase: "committed",
      updatedAt: now,
    });
    recovered++;
  }
  if (recovered > 0) {
    await recordWorkspaceMetric("recovery-attempted").catch(() => undefined);
    await recordWorkspaceMetric("recovery-succeeded").catch(() => undefined);
  }
  return recovered;
}

export async function hasLegacyMobileCleanupCandidate(): Promise<boolean> {
  if (!new Directory(Paths.document, "workspace").exists) return false;
  return (await listMobileWorkspaceMigrations()).some(
    (journal) => journal.phase === "committed" && !journal.legacyCleanedAt
  );
}

/** Deletes legacy mobile data only after an explicit user action. */
export async function cleanupMigratedLegacyMobileStorage(
  targetProjectId?: string
): Promise<number> {
  const journals = await listMobileWorkspaceMigrations();
  const committed = journals.filter(
    (journal) =>
      journal.phase === "committed" &&
      !journal.legacyCleanedAt &&
      (!targetProjectId || journal.targetProject.id === targetProjectId)
  );
  if (committed.length === 0) return 0;
  const cleanedAt = Date.now();
  // Delete the most specific roots first. A legacy-default journal points at
  // the shared root and is intentionally handled last.
  for (const journal of [...committed].sort((a, b) => b.sourceRoot.length - a.sourceRoot.length)) {
    const source = new Directory(journal.sourceRoot);
    if (source.exists) source.delete();
    const file = migrationFile(journal.targetProject.localReplica.storageKey);
    writeJournal(file, { ...journal, legacyCleanedAt: cleanedAt, updatedAt: cleanedAt });
  }
  return committed.length;
}
