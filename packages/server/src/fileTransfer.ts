// ── File Upload / Download ──────────────────────────────

import type { IncomingMessage, ServerResponse } from "http";
import { createReadStream, existsSync, statSync, readdirSync } from "fs";
import { join, resolve, basename, extname, relative } from "path";
import { mkdir, writeFile, readFile, stat as fsStat } from "fs/promises";
import { verifyToken } from "./auth.js";
import { getSession } from "./db.js";
import { getWorkspaceRoot } from "./tools.js";

const MAX_UPLOAD_SIZE = parseInt(process.env.MAX_UPLOAD_SIZE || "52428800", 10); // 50MB
const MAX_SYNC_SIZE = 50 * 1024 * 1024; // 50MB total for workspace sync

// ── Helpers ──────────────────────────────────────────────

function getAuthToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return null;
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

/** Resolve workspace path from session, using project-aware getWorkspaceRoot */
function resolveWorkspace(sessionId: string, projectId?: string): string {
  return getWorkspaceRoot(sessionId, projectId || undefined);
}

// ── Upload ───────────────────────────────────────────────

/**
 * Handle file upload via multipart/form-data or raw body.
 * POST /api/files/upload
 * Headers: Authorization: Bearer <token>
 * Query: ?sessionId=xxx&path=xxx (target path in workspace)
 */
export async function handleFileUpload(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  // Auth check
  const token = getAuthToken(req);
  if (!token) {
    sendJson(res, 401, { error: "Missing authorization" });
    return;
  }
  const auth = verifyToken(token);
  if (!auth) {
    sendJson(res, 401, { error: "Invalid token" });
    return;
  }

  const url = new URL(req.url || "", "http://localhost");
  const sessionId = url.searchParams.get("sessionId");
  const targetPath = url.searchParams.get("path") || "";

  if (!sessionId) {
    sendJson(res, 400, { error: "sessionId is required" });
    return;
  }

  // Find session workspace
  const session = getSession(sessionId);
  if (!session) {
    sendJson(res, 404, { error: "Session not found" });
    return;
  }
  if (session.userId !== auth.userId) {
    sendJson(res, 403, { error: "Session does not belong to this user" });
    return;
  }

  // Read raw body
  const chunks: Buffer[] = [];
  let totalSize = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      req.on("data", (chunk: Buffer) => {
        totalSize += chunk.length;
        if (totalSize > MAX_UPLOAD_SIZE) {
          reject(new Error(`File too large (max ${MAX_UPLOAD_SIZE / 1024 / 1024}MB)`));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve());
      req.on("error", reject);
    });
  } catch (err: any) {
    sendJson(res, 413, { error: err.message });
    return;
  }

  const body = Buffer.concat(chunks);

  // Determine file name from Content-Disposition or query param
  let fileName = url.searchParams.get("fileName") || "upload";
  const disposition = req.headers["content-disposition"];
  if (disposition) {
    const match = disposition.match(/filename="?([^";\n]+)"?/);
    if (match) fileName = match[1];
  }

  // Resolve workspace using project-aware path (consistent with tools.ts)
  const workspace = resolveWorkspace(sessionId, session.projectId);
  const fullTarget = resolve(workspace, targetPath, fileName);

  if (!fullTarget.startsWith(resolve(workspace))) {
    sendJson(res, 400, { error: "Invalid path (path traversal detected)" });
    return;
  }

  try {
    await mkdir(join(fullTarget, ".."), { recursive: true });
    await writeFile(fullTarget, body);
    sendJson(res, 200, {
      success: true,
      path: fullTarget.replace(workspace, "").replace(/^\//, ""),
      size: body.length,
    });
  } catch (err: any) {
    sendJson(res, 500, { error: err.message });
  }
}

// ── Download ─────────────────────────────────────────────

/**
 * Handle file download.
 * GET /api/files/download?sessionId=xxx&path=xxx
 * Headers: Authorization: Bearer <token>
 */
export async function handleFileDownload(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<void> {
  // Auth check
  const token = getAuthToken(req);
  if (!token) {
    sendJson(res, 401, { error: "Missing authorization" });
    return;
  }
  const auth = verifyToken(token);
  if (!auth) {
    sendJson(res, 401, { error: "Invalid token" });
    return;
  }

  const sessionId = url.searchParams.get("sessionId");
  const filePath = url.searchParams.get("path");

  if (!sessionId || !filePath) {
    sendJson(res, 400, { error: "sessionId and path are required" });
    return;
  }

  // Find session workspace
  const session = getSession(sessionId);
  if (!session) {
    sendJson(res, 404, { error: "Session not found" });
    return;
  }
  if (session.userId !== auth.userId) {
    sendJson(res, 403, { error: "Session does not belong to this user" });
    return;
  }

  // Resolve workspace using project-aware path (consistent with tools.ts)
  const workspace = resolveWorkspace(sessionId, session.projectId);
  const fullPath = resolve(workspace, filePath);

  // Prevent path traversal
  if (!fullPath.startsWith(resolve(workspace))) {
    sendJson(res, 400, { error: "Invalid path" });
    return;
  }

  if (!existsSync(fullPath)) {
    sendJson(res, 404, { error: "File not found" });
    return;
  }

  const fileStat = statSync(fullPath);
  if (!fileStat.isFile()) {
    sendJson(res, 400, { error: "Not a file" });
    return;
  }

  const ext = extname(fullPath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".txt": "text/plain",
    ".json": "application/json",
    ".js": "application/javascript",
    ".ts": "application/typescript",
    ".html": "text/html",
    ".css": "text/css",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
  };

  res.writeHead(200, {
    "Content-Type": mimeTypes[ext] || "application/octet-stream",
    "Content-Length": fileStat.size,
    "Content-Disposition": `attachment; filename="${basename(fullPath)}"`,
  });

  const stream = createReadStream(fullPath);
  stream.pipe(res);
}

// ── Workspace Sync ──────────────────────────────────────

/** Binary file extensions that should be base64 encoded */
const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp",
  ".pdf", ".zip", ".gz", ".tar", ".7z", ".rar",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".mp3", ".mp4", ".wav", ".ogg", ".webm",
  ".exe", ".dll", ".so", ".dylib",
  ".sqlite", ".db",
]);

/** Directories to skip during sync */
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build", ".cache",
  "__pycache__", ".venv", "venv",
]);

interface SyncFile {
  path: string;
  content: string;
  size: number;
  encoding: "utf8" | "base64";
}

/** Recursively collect files from a directory */
function collectFiles(
  dir: string,
  baseDir: string,
  files: SyncFile[],
  sizeAccumulator: { total: number }
): void {
  if (!existsSync(dir)) return;

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;

    const fullPath = join(dir, entry.name);
    const relPath = relative(baseDir, fullPath);

    if (entry.isDirectory()) {
      collectFiles(fullPath, baseDir, files, sizeAccumulator);
    } else if (entry.isFile()) {
      const fileStat = statSync(fullPath);

      // Skip large individual files (>2MB)
      if (fileStat.size > 2 * 1024 * 1024) continue;

      // Check total size limit
      if (sizeAccumulator.total + fileStat.size > MAX_SYNC_SIZE) continue;

      const ext = extname(entry.name).toLowerCase();
      const isBinary = BINARY_EXTS.has(ext);

      try {
        const raw = require("fs").readFileSync(fullPath);
        const content = isBinary
          ? raw.toString("base64")
          : raw.toString("utf8");

        sizeAccumulator.total += fileStat.size;
        files.push({
          path: relPath,
          content,
          size: fileStat.size,
          encoding: isBinary ? "base64" : "utf8",
        });
      } catch {
        // Skip unreadable files
      }
    }
  }
}

/**
 * Handle workspace sync — returns all files in a project workspace as JSON.
 * GET /api/workspace/sync?projectId=xxx
 * Headers: Authorization: Bearer <token>
 */
export async function handleWorkspaceSync(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<void> {
  // Auth check
  const token = getAuthToken(req);
  if (!token) {
    sendJson(res, 401, { error: "Missing authorization" });
    return;
  }
  const auth = verifyToken(token);
  if (!auth) {
    sendJson(res, 401, { error: "Invalid token" });
    return;
  }

  const projectId = url.searchParams.get("projectId");
  if (!projectId) {
    sendJson(res, 400, { error: "projectId is required" });
    return;
  }

  // Use project-level workspace (sessionId empty since we want project root)
  const workspace = getWorkspaceRoot("", projectId);

  if (!existsSync(workspace)) {
    sendJson(res, 404, { error: "Workspace not found" });
    return;
  }

  const files: SyncFile[] = [];
  const sizeAccumulator = { total: 0 };

  collectFiles(workspace, workspace, files, sizeAccumulator);

  sendJson(res, 200, {
    files,
    totalSize: sizeAccumulator.total,
    fileCount: files.length,
  });
}
