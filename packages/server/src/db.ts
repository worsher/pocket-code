import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { join, resolve, dirname } from "path";
import { homedir } from "os";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import type { CoreMessage } from "ai";

// ── Database setup ──────────────────────────────────────

const DB_PATH =
  process.env.DB_PATH ||
  resolve(join(homedir(), ".pocket-code", "pocket-code.db"));

// Ensure directory exists
mkdirSync(dirname(DB_PATH), { recursive: true });

let db: SqlJsDatabase;

/** Initialise the database. Must be called (and awaited) once before using
 *  any of the other exported functions. */
export async function initDb(): Promise<void> {
  const SQL = await initSqlJs();

  if (existsSync(DB_PATH)) {
    const buffer = readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  // WAL is not supported by sql.js (in-memory), but we persist manually
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT DEFAULT '',
      messages TEXT DEFAULT '[]',
      model_key TEXT DEFAULT 'deepseek-v3',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);`);

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
  writeFileSync(DB_PATH, Buffer.from(data));
}

// ── Types ───────────────────────────────────────────────

export interface SessionRecord {
  sessionId: string;
  userId: string;
  title: string;
  messages: CoreMessage[];
  modelKey: string;
  createdAt: number;
  updatedAt: number;
}

export interface SessionInfo {
  sessionId: string;
  title: string;
  modelKey: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

// ── Public API ──────────────────────────────────────────

/** Save or update a session */
export function saveSession(
  sessionId: string,
  userId: string,
  messages: CoreMessage[],
  modelKey: string
): void {
  const now = Date.now();
  const firstUserMsg = messages.find((m) => m.role === "user");
  const title =
    typeof firstUserMsg?.content === "string"
      ? firstUserMsg.content.slice(0, 50)
      : "";

  db.run(
    `INSERT INTO sessions (session_id, user_id, title, messages, model_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       title = excluded.title,
       messages = excluded.messages,
       model_key = excluded.model_key,
       updated_at = excluded.updated_at`,
    [sessionId, userId, title, JSON.stringify(messages), modelKey, now, now]
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
    title: row.title as string,
    messages: JSON.parse(row.messages as string),
    modelKey: row.model_key as string,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

/** List sessions for a user */
export function listUserSessions(
  userId: string,
  limit: number = 50
): SessionInfo[] {
  const stmt = db.prepare(
    `SELECT session_id, user_id, title, model_key, messages,
            created_at, updated_at
     FROM sessions
     WHERE user_id = ?
     ORDER BY updated_at DESC
     LIMIT ?`
  );
  stmt.bind([userId, limit]);

  const results: SessionInfo[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    const msgs = JSON.parse(row.messages as string);
    results.push({
      sessionId: row.session_id as string,
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
  db.run("DELETE FROM sessions WHERE session_id = ? AND user_id = ?", [
    sessionId,
    userId,
  ]);
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
  usage: { dailyApiCallsUsed: number; totalContainerTimeSec: number; diskUsageMB: number; lastResetDate: string }
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
    [userId, tier, usage.dailyApiCallsUsed, usage.totalContainerTimeSec, usage.diskUsageMB, usage.lastResetDate, Date.now()]
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
    [user.userId, user.githubId, user.githubLogin, user.githubToken, user.displayName, user.avatarUrl, Date.now(), Date.now()]
  );
  persist();
}
