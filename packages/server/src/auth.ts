import jwt, { type SignOptions } from "jsonwebtoken";
import crypto from "crypto";
import { join, resolve } from "path";
import { homedir } from "os";
import { readFileSync, writeFileSync, mkdirSync } from "fs";

// ── Config ──────────────────────────────────────────────

/**
 * JWT Secret resolution order:
 * 1. JWT_SECRET environment variable (highest priority)
 * 2. Persisted secret from ~/.pocket-code/jwt-secret (survives restarts)
 * 3. Auto-generated + persisted (first run only)
 */
function resolveJwtSecret(): string {
  if (process.env.JWT_SECRET) {
    return process.env.JWT_SECRET;
  }
  const secretDir = resolve(join(homedir(), ".pocket-code"));
  const secretPath = join(secretDir, "jwt-secret");
  try {
    return readFileSync(secretPath, "utf-8").trim();
  } catch {
    // File doesn't exist — generate and persist
    const secret = crypto.randomBytes(32).toString("hex");
    mkdirSync(secretDir, { recursive: true });
    writeFileSync(secretPath, secret, { mode: 0o600 }); // owner-only read/write
    console.log(`[Auth] Generated and persisted JWT secret to ${secretPath}`);
    return secret;
  }
}

const JWT_SECRET = resolveJwtSecret();
const JWT_EXPIRES_IN = (process.env.JWT_EXPIRES_IN || "30d") as SignOptions["expiresIn"];

export interface AuthPayload {
  userId: string;
  deviceId: string;
  githubId?: number;
  githubLogin?: string;
}

// ── Token helpers ───────────────────────────────────────

/** Sign a JWT for the given user */
export function signToken(payload: AuthPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

/** Verify and decode a JWT. Returns null on failure. */
export function verifyToken(token: string): AuthPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as AuthPayload;
  } catch {
    return null;
  }
}

// ── Rate limiting for anonymous registration ────────────

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const RATE_LIMIT_MAX_REQUESTS = 5; // max 5 registrations per window

interface RateLimitEntry {
  timestamps: number[];
}

const rateLimitMap = new Map<string, RateLimitEntry>();

// Periodic cleanup of expired rate limit entries (every 5 min)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    entry.timestamps = entry.timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    if (entry.timestamps.length === 0) {
      rateLimitMap.delete(key);
    }
  }
}, 5 * 60 * 1000);

function checkRateLimit(key: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry) {
    rateLimitMap.set(key, { timestamps: [now] });
    return true;
  }
  // Clean old entries
  entry.timestamps = entry.timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  if (entry.timestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
    return false; // Rate limited
  }
  entry.timestamps.push(now);
  return true;
}

// ── Anonymous registration ──────────────────────────────

/**
 * Register an anonymous user:
 *   - Client sends a deviceId (persistent per device)
 *   - Server generates a userId and returns a JWT
 *   - Rate-limited to prevent abuse
 */
export function registerAnonymous(deviceId: string): {
  token: string;
  userId: string;
} | { error: string } {
  if (!checkRateLimit(deviceId)) {
    return { error: "Too many registrations. Please try again later." };
  }
  const userId = `u_${crypto.randomBytes(8).toString("hex")}`;
  const token = signToken({ userId, deviceId });
  return { token, userId };
}

