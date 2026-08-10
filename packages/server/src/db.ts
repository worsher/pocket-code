import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { join, resolve, dirname } from "path";
import { homedir } from "os";
import { mkdirSync, readFileSync, existsSync } from "fs";
import { randomUUID } from "crypto";
import type { CoreMessage } from "@pocket-code/agent-core";
import {
  createReplicaId,
  createStorageKey,
  parseProjectId,
  parseReplicaId,
  parseStorageKey,
  type ImportMode,
  type ImportSourceKind,
  type SourceIdentity,
  type UuidFactory,
} from "@pocket-code/workspace-core";
import { atomicWriteFileSync } from "./atomicFile.js";

// ── Database setup ──────────────────────────────────────

const legacyDbPath = resolve(join(homedir(), ".pocket-code", "pocket-code.db"));
const v2DataRoot =
  process.env.POCKET_CODE_DATA_ROOT || resolve(join(homedir(), ".pocket-code", "v2"));
const DB_PATH =
  process.env.DB_PATH ||
  (existsSync(legacyDbPath)
    ? legacyDbPath
    : resolve(join(v2DataRoot, "catalog", "pocket-code.db")));
const DB_BACKUP_PATH = `${DB_PATH}.backup`;

// Ensure directory exists
mkdirSync(dirname(DB_PATH), { recursive: true });

let db: SqlJsDatabase;
let primaryDatabaseFileIsValid = false;

/** Initialise the database. Must be called (and awaited) once before using
 *  any of the other exported functions. */
export async function initDb(): Promise<void> {
  const SQL = await initSqlJs();
  const openVerifiedDatabase = (data: Uint8Array): SqlJsDatabase => {
    const candidate = new SQL.Database(data);
    try {
      // sql.js defers malformed-file errors until the first statement.
      candidate.exec("PRAGMA schema_version");
      return candidate;
    } catch (error) {
      candidate.close();
      throw error;
    }
  };

  if (existsSync(DB_PATH)) {
    try {
      db = openVerifiedDatabase(readFileSync(DB_PATH));
      primaryDatabaseFileIsValid = true;
    } catch (primaryError) {
      if (!existsSync(DB_BACKUP_PATH)) throw primaryError;
      try {
        db = openVerifiedDatabase(readFileSync(DB_BACKUP_PATH));
        primaryDatabaseFileIsValid = false;
      } catch (backupError) {
        throw new AggregateError(
          [primaryError, backupError],
          "Primary and backup Pocket Code databases are both unreadable",
          { cause: backupError }
        );
      }
    }
  } else {
    db = new SQL.Database();
    primaryDatabaseFileIsValid = false;
  }

  // WAL is not supported by sql.js (in-memory), but we persist manually
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      project_id TEXT NOT NULL DEFAULT '',
      title TEXT DEFAULT '',
      messages TEXT DEFAULT '[]',
      model_key TEXT DEFAULT 'deepseek-v4-flash',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);`);

  // Migration: add project_id column to existing sessions table (if upgrading from older schema)
  // Must run BEFORE creating the index on project_id
  try {
    db.run(`ALTER TABLE sessions ADD COLUMN project_id TEXT NOT NULL DEFAULT ''`);
  } catch {
    // Column already exists — safe to ignore
  }
  // P16: goal 状态持久化(JSON;NULL = 无目标)
  try {
    db.run(`ALTER TABLE sessions ADD COLUMN goal_json TEXT`);
  } catch {
    // Column already exists — safe to ignore
  }
  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);`);

  // Workspace Storage v2 catalog. Physical storage keys are random and scoped
  // by the (user_id, project_id) catalog row; client IDs never become paths.
  db.run(`
    CREATE TABLE IF NOT EXISTS workspace_projects (
      user_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      replica_id TEXT NOT NULL,
      storage_key TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL DEFAULT '',
      worktree_path TEXT,
      import_source_json TEXT,
      generation INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, project_id)
    );
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_workspace_projects_user ON workspace_projects(user_id);`);
  try {
    db.run(`ALTER TABLE workspace_projects ADD COLUMN display_name TEXT NOT NULL DEFAULT ''`);
  } catch {
    // Column already exists.
  }
  try {
    db.run(`ALTER TABLE workspace_projects ADD COLUMN worktree_path TEXT`);
  } catch {
    // Column already exists.
  }
  try {
    db.run(`ALTER TABLE workspace_projects ADD COLUMN import_source_json TEXT`);
  } catch {
    // Column already exists.
  }

  // Stable identity for this catalog/database. Clients use it to distinguish
  // replicas hosted by different cloud servers or developer machines.
  db.run(`
    CREATE TABLE IF NOT EXISTS workspace_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // User quotas table
  db.run(`
    CREATE TABLE IF NOT EXISTS user_quotas (
      user_id TEXT PRIMARY KEY,
      tier TEXT DEFAULT 'free',
      daily_api_calls_used INTEGER DEFAULT 0,
      total_container_time_sec INTEGER DEFAULT 0,
      disk_usage_mb REAL DEFAULT 0,
      last_reset_date TEXT DEFAULT '',
      updated_at INTEGER NOT NULL
    );
  `);

  // Users table (for OAuth)
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      github_id INTEGER UNIQUE,
      github_login TEXT,
      github_token TEXT,
      display_name TEXT,
      avatar_url TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  persist();
}

/** Flush current database state to disk */
function persist(): void {
  const data = db.export();
  if (primaryDatabaseFileIsValid && existsSync(DB_PATH)) {
    atomicWriteFileSync(DB_BACKUP_PATH, readFileSync(DB_PATH));
  }
  atomicWriteFileSync(DB_PATH, data);
  primaryDatabaseFileIsValid = true;
}

// ── Types ───────────────────────────────────────────────

export interface SessionRecord {
  sessionId: string;
  userId: string;
  projectId: string;
  title: string;
  messages: CoreMessage[];
  modelKey: string;
  /** P16:goal 状态 JSON(null = 无目标)。 */
  goalJson: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SessionInfo {
  sessionId: string;
  projectId: string;
  title: string;
  modelKey: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface WorkspaceProjectRecord {
  userId: string;
  projectId: string;
  replicaId: string;
  storageKey: string;
  displayName: string;
  worktreePath?: string;
  importSource?: WorkspaceImportSourceRecord;
  generation: number;
  createdAt: number;
  updatedAt: number;
}

export interface WorkspaceImportSourceRecord {
  mode: ImportMode;
  sourceKind: ImportSourceKind;
  sourceDeviceId: string;
  canonicalLocator?: string;
  identity: SourceIdentity;
  importedSnapshot: string;
  importedAt: number;
  writeBackPolicy: "explicit" | "linked" | "git";
}

// ── Public API ──────────────────────────────────────────

/** Save or update a session */
export function saveSession(
  sessionId: string,
  userId: string,
  messages: CoreMessage[],
  modelKey: string,
  projectId: string = ""
): void {
  const now = Date.now();
  const firstUserMsg = messages.find((m) => m.role === "user");
  const title = typeof firstUserMsg?.content === "string" ? firstUserMsg.content.slice(0, 50) : "";

  db.run(
    `INSERT INTO sessions (session_id, user_id, project_id, title, messages, model_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       project_id = excluded.project_id,
       title = excluded.title,
       messages = excluded.messages,
       model_key = excluded.model_key,
       updated_at = excluded.updated_at`,
    [sessionId, userId, projectId, title, JSON.stringify(messages), modelKey, now, now]
  );
  persist();
}

/** Get a session by ID */
export function getSession(sessionId: string): SessionRecord | null {
  const stmt = db.prepare("SELECT * FROM sessions WHERE session_id = ?");
  stmt.bind([sessionId]);
  if (!stmt.step()) {
    stmt.free();
    return null;
  }
  const row = stmt.getAsObject();
  stmt.free();
  return {
    sessionId: row.session_id as string,
    userId: row.user_id as string,
    projectId: (row.project_id as string) || "",
    title: row.title as string,
    messages: JSON.parse(row.messages as string),
    modelKey: row.model_key as string,
    goalJson: (row.goal_json as string) || null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

/** P16:落盘 goal 状态(null = 清除)。session 行不存在时为 no-op。 */
export function saveSessionGoal(sessionId: string, goalJson: string | null): void {
  db.run("UPDATE sessions SET goal_json = ?, updated_at = ? WHERE session_id = ?", [
    goalJson,
    Date.now(),
    sessionId,
  ]);
  persist();
}

/** List sessions for a user, optionally filtered by projectId */
export function listUserSessions(
  userId: string,
  limit: number = 50,
  projectId?: string
): SessionInfo[] {
  const sql =
    projectId !== undefined
      ? `SELECT session_id, user_id, project_id, title, model_key, messages,
              created_at, updated_at
       FROM sessions
       WHERE user_id = ? AND project_id = ?
       ORDER BY updated_at DESC
       LIMIT ?`
      : `SELECT session_id, user_id, project_id, title, model_key, messages,
              created_at, updated_at
       FROM sessions
       WHERE user_id = ?
       ORDER BY updated_at DESC
       LIMIT ?`;

  const stmt = db.prepare(sql);
  stmt.bind(projectId !== undefined ? [userId, projectId, limit] : [userId, limit]);

  const results: SessionInfo[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    const msgs = JSON.parse(row.messages as string);
    results.push({
      sessionId: row.session_id as string,
      projectId: (row.project_id as string) || "",
      title: row.title as string,
      modelKey: row.model_key as string,
      messageCount: Array.isArray(msgs) ? msgs.length : 0,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    });
  }
  stmt.free();
  return results;
}

/** Delete a session */
export function deleteSession(sessionId: string, userId: string): boolean {
  const before = db.getRowsModified();
  db.run("DELETE FROM sessions WHERE session_id = ? AND user_id = ?", [sessionId, userId]);
  const after = db.getRowsModified();
  if (after > 0) persist();
  return after > 0;
}

/** Clean up old sessions (default: 7 days) */
export function cleanupOldSessions(maxAgeDays: number = 7): number {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  db.run("DELETE FROM sessions WHERE updated_at < ?", [cutoff]);
  const changes = db.getRowsModified();
  if (changes > 0) persist();
  return changes;
}

// ── Workspace Storage v2 catalog ───────────────────────

function parseWorkspaceImportSource(value: unknown): WorkspaceImportSourceRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Partial<WorkspaceImportSourceRecord>;
  const identity = source.identity;
  if (
    (source.mode !== "copy" && source.mode !== "linked" && source.mode !== "git") ||
    (source.sourceKind !== "directory" &&
      source.sourceKind !== "archive" &&
      source.sourceKind !== "git") ||
    typeof source.sourceDeviceId !== "string" ||
    !source.sourceDeviceId ||
    (source.canonicalLocator !== undefined && typeof source.canonicalLocator !== "string") ||
    !identity ||
    identity.importMode !== source.mode ||
    identity.sourceKind !== source.sourceKind ||
    (identity.strongKey !== undefined && typeof identity.strongKey !== "string") ||
    !Array.isArray(identity.weakKeys) ||
    !identity.weakKeys.every((key) => typeof key === "string") ||
    typeof source.importedSnapshot !== "string" ||
    !source.importedSnapshot ||
    typeof source.importedAt !== "number" ||
    !Number.isFinite(source.importedAt) ||
    (source.writeBackPolicy !== "explicit" &&
      source.writeBackPolicy !== "linked" &&
      source.writeBackPolicy !== "git")
  ) {
    return undefined;
  }
  return source as WorkspaceImportSourceRecord;
}

function workspaceProjectFromRow(row: Record<string, unknown>): WorkspaceProjectRecord {
  let importSource: WorkspaceImportSourceRecord | undefined;
  if (typeof row.import_source_json === "string" && row.import_source_json) {
    try {
      importSource = parseWorkspaceImportSource(JSON.parse(row.import_source_json));
    } catch {
      // Corrupt optional metadata must not make the project catalog unreadable.
    }
  }
  return {
    userId: row.user_id as string,
    projectId: parseProjectId(row.project_id as string),
    replicaId: parseReplicaId(row.replica_id as string),
    storageKey: parseStorageKey(row.storage_key as string),
    displayName: (row.display_name as string) || "",
    worktreePath: (row.worktree_path as string) || undefined,
    importSource,
    generation: row.generation as number,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

export function getWorkspaceProject(
  userId: string,
  projectId: string
): WorkspaceProjectRecord | null {
  const stmt = db.prepare(
    `SELECT user_id, project_id, replica_id, storage_key, display_name, worktree_path,
            import_source_json, generation, created_at, updated_at
     FROM workspace_projects
     WHERE user_id = ? AND project_id = ?`
  );
  stmt.bind([userId, projectId]);
  if (!stmt.step()) {
    stmt.free();
    return null;
  }
  const row = stmt.getAsObject();
  stmt.free();
  return workspaceProjectFromRow(row);
}

export function listWorkspaceProjects(userId: string): WorkspaceProjectRecord[] {
  const stmt = db.prepare(
    `SELECT user_id, project_id, replica_id, storage_key, display_name, worktree_path,
            import_source_json, generation, created_at, updated_at
     FROM workspace_projects
     WHERE user_id = ?
     ORDER BY created_at ASC`
  );
  stmt.bind([userId]);
  const records: WorkspaceProjectRecord[] = [];
  while (stmt.step()) {
    records.push(workspaceProjectFromRow(stmt.getAsObject()));
  }
  stmt.free();
  return records;
}

export function updateWorkspaceProjectDisplayName(
  userId: string,
  projectId: string,
  displayName: string
): void {
  const normalized = displayName.trim().slice(0, 256);
  if (!normalized) return;
  db.run(
    `UPDATE workspace_projects
     SET display_name = ?, updated_at = ?
     WHERE user_id = ? AND project_id = ? AND display_name <> ?`,
    [normalized, Date.now(), userId, parseProjectId(projectId), normalized]
  );
  if (db.getRowsModified() > 0) persist();
}

/**
 * Generation-guarded release used before a client hands the writer role to its
 * mobile replica. Bumping the server replica generation invalidates every
 * session that was created under the previous writer lease.
 */
export function releaseWorkspaceProjectWriter(args: {
  userId: string;
  projectId: string;
  replicaId: string;
  expectedGeneration: number;
}): WorkspaceProjectRecord {
  const projectId = parseProjectId(args.projectId);
  const replicaId = parseReplicaId(args.replicaId);
  db.run(
    `UPDATE workspace_projects
     SET generation = generation + 1, updated_at = ?
     WHERE user_id = ? AND project_id = ? AND replica_id = ? AND generation = ?`,
    [Date.now(), args.userId, projectId, replicaId, args.expectedGeneration]
  );
  if (db.getRowsModified() !== 1) {
    throw new Error("Writer release rejected because the workspace generation is stale");
  }
  persist();
  const updated = getWorkspaceProject(args.userId, projectId);
  if (!updated) throw new Error("Workspace project disappeared during writer release");
  return updated;
}

export function isWorkspaceSessionGenerationCurrent(args: {
  userId: string;
  projectId: string;
  replicaId: string;
  generation: number;
}): boolean {
  const project = getWorkspaceProject(args.userId, args.projectId);
  return (
    !!project && project.replicaId === args.replicaId && project.generation === args.generation
  );
}

export function ensureWorkspaceProject(
  userId: string,
  projectId: string,
  uuidFactory: UuidFactory = randomUUID
): WorkspaceProjectRecord {
  if (!userId) throw new Error("User ID is required for a v2 workspace");
  const safeProjectId = parseProjectId(projectId);
  const existing = getWorkspaceProject(userId, safeProjectId);
  if (existing) return existing;

  const now = Date.now();
  const replicaId = createReplicaId(uuidFactory);
  const storageKey = createStorageKey(uuidFactory);
  db.run(
    `INSERT OR IGNORE INTO workspace_projects
       (user_id, project_id, replica_id, storage_key, generation, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
    [userId, safeProjectId, replicaId, storageKey, now, now]
  );
  if (db.getRowsModified() > 0) persist();

  const created = getWorkspaceProject(userId, safeProjectId);
  if (!created) throw new Error("Failed to create workspace project catalog entry");
  return created;
}

export function bindLinkedWorkspaceProject(
  args: {
    userId: string;
    projectId: string;
    displayName: string;
    worktreePath: string;
    importSource: WorkspaceImportSourceRecord;
  },
  uuidFactory: UuidFactory = randomUUID
): WorkspaceProjectRecord {
  if (!args.userId) throw new Error("User ID is required for a linked workspace");
  const projectId = parseProjectId(args.projectId);
  if (getWorkspaceProject(args.userId, projectId)) {
    throw new Error("Project already exists in this workspace catalog");
  }
  const importSource = parseWorkspaceImportSource(args.importSource);
  if (!importSource || importSource.mode !== "linked") {
    throw new Error("Invalid linked workspace source metadata");
  }
  const now = Date.now();
  const replicaId = createReplicaId(uuidFactory);
  const storageKey = createStorageKey(uuidFactory);
  db.run(
    `INSERT INTO workspace_projects
       (user_id, project_id, replica_id, storage_key, display_name, worktree_path,
        import_source_json, generation, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [
      args.userId,
      projectId,
      replicaId,
      storageKey,
      args.displayName.trim().slice(0, 256),
      args.worktreePath,
      JSON.stringify(importSource),
      now,
      now,
    ]
  );
  persist();
  const created = getWorkspaceProject(args.userId, projectId);
  if (!created) throw new Error("Failed to bind linked workspace project");
  return created;
}

export function deleteWorkspaceProject(userId: string, projectId: string): boolean {
  db.run("DELETE FROM workspace_projects WHERE user_id = ? AND project_id = ?", [
    userId,
    parseProjectId(projectId),
  ]);
  const changed = db.getRowsModified() > 0;
  if (changed) persist();
  return changed;
}

export function getWorkspaceAuthorityId(uuidFactory: UuidFactory = randomUUID): string {
  const stmt = db.prepare("SELECT value FROM workspace_meta WHERE key = 'authority_id'");
  let existing: string | null = null;
  if (stmt.step()) existing = stmt.getAsObject().value as string;
  stmt.free();
  if (existing) return parseReplicaId(existing);

  const authorityId = parseReplicaId(uuidFactory());
  db.run("INSERT OR IGNORE INTO workspace_meta (key, value) VALUES ('authority_id', ?)", [
    authorityId,
  ]);
  if (db.getRowsModified() > 0) persist();

  const saved = db.prepare("SELECT value FROM workspace_meta WHERE key = 'authority_id'");
  if (!saved.step()) {
    saved.free();
    throw new Error("Failed to create workspace authority identity");
  }
  const value = parseReplicaId(saved.getAsObject().value as string);
  saved.free();
  return value;
}

// ── User Quotas ─────────────────────────────────────────

export interface QuotaRecord {
  tier: string;
  dailyApiCallsUsed: number;
  totalContainerTimeSec: number;
  diskUsageMB: number;
  lastResetDate: string;
}

export function getQuotaRecord(userId: string): QuotaRecord | null {
  const stmt = db.prepare("SELECT * FROM user_quotas WHERE user_id = ?");
  stmt.bind([userId]);
  if (!stmt.step()) {
    stmt.free();
    return null;
  }
  const row = stmt.getAsObject();
  stmt.free();
  return {
    tier: row.tier as string,
    dailyApiCallsUsed: row.daily_api_calls_used as number,
    totalContainerTimeSec: row.total_container_time_sec as number,
    diskUsageMB: row.disk_usage_mb as number,
    lastResetDate: row.last_reset_date as string,
  };
}

export function upsertQuotaRecord(
  userId: string,
  tier: string,
  usage: {
    dailyApiCallsUsed: number;
    totalContainerTimeSec: number;
    diskUsageMB: number;
    lastResetDate: string;
  }
): void {
  db.run(
    `INSERT INTO user_quotas (user_id, tier, daily_api_calls_used, total_container_time_sec, disk_usage_mb, last_reset_date, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       tier = excluded.tier,
       daily_api_calls_used = excluded.daily_api_calls_used,
       total_container_time_sec = excluded.total_container_time_sec,
       disk_usage_mb = excluded.disk_usage_mb,
       last_reset_date = excluded.last_reset_date,
       updated_at = excluded.updated_at`,
    [
      userId,
      tier,
      usage.dailyApiCallsUsed,
      usage.totalContainerTimeSec,
      usage.diskUsageMB,
      usage.lastResetDate,
      Date.now(),
    ]
  );
  persist();
}

// ── Users (OAuth) ────────────────────────────────────────

export interface UserRecord {
  userId: string;
  githubId: number | null;
  githubLogin: string | null;
  githubToken: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

export function getUser(userId: string): UserRecord | null {
  const stmt = db.prepare("SELECT * FROM users WHERE user_id = ?");
  stmt.bind([userId]);
  if (!stmt.step()) {
    stmt.free();
    return null;
  }
  const row = stmt.getAsObject();
  stmt.free();
  return {
    userId: row.user_id as string,
    githubId: row.github_id as number | null,
    githubLogin: row.github_login as string | null,
    githubToken: row.github_token as string | null,
    displayName: row.display_name as string | null,
    avatarUrl: row.avatar_url as string | null,
  };
}

export function getUserByGithubId(githubId: number): UserRecord | null {
  const stmt = db.prepare("SELECT * FROM users WHERE github_id = ?");
  stmt.bind([githubId]);
  if (!stmt.step()) {
    stmt.free();
    return null;
  }
  const row = stmt.getAsObject();
  stmt.free();
  return {
    userId: row.user_id as string,
    githubId: row.github_id as number | null,
    githubLogin: row.github_login as string | null,
    githubToken: row.github_token as string | null,
    displayName: row.display_name as string | null,
    avatarUrl: row.avatar_url as string | null,
  };
}

export function upsertUser(user: UserRecord): void {
  db.run(
    `INSERT INTO users (user_id, github_id, github_login, github_token, display_name, avatar_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       github_id = excluded.github_id,
       github_login = excluded.github_login,
       github_token = excluded.github_token,
       display_name = excluded.display_name,
       avatar_url = excluded.avatar_url,
       updated_at = excluded.updated_at`,
    [
      user.userId,
      user.githubId,
      user.githubLogin,
      user.githubToken,
      user.displayName,
      user.avatarUrl,
      Date.now(),
      Date.now(),
    ]
  );
  persist();
}
