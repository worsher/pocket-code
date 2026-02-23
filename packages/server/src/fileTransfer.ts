// ── File Upload / Download ──────────────────────────────

import type { IncomingMessage, ServerResponse } from "http";
import { createReadStream, existsSync, statSync } from "fs";
import { join, resolve, basename, extname } from "path";
import { mkdir, writeFile } from "fs/promises";
import { verifyToken } from "./auth.js";
import { getSession } from "./db.js";

const MAX_UPLOAD_SIZE = parseInt(process.env.MAX_UPLOAD_SIZE || "52428800", 10); // 50MB

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

  // Resolve target path within workspace (prevent path traversal)
  // Use a fixed workspace root based on session userId
  const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || join(process.cwd(), "workspaces");
  const workspace = join(WORKSPACE_ROOT, auth.userId, sessionId);
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

  const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || join(process.cwd(), "workspaces");
  const workspace = join(WORKSPACE_ROOT, auth.userId, sessionId);
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

  const stat = statSync(fullPath);
  if (!stat.isFile()) {
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
    "Content-Length": stat.size,
    "Content-Disposition": `attachment; filename="${basename(fullPath)}"`,
  });

  const stream = createReadStream(fullPath);
  stream.pipe(res);
}
