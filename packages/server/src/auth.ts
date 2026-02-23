import jwt, { type SignOptions } from "jsonwebtoken";
import crypto from "crypto";

// ── Config ──────────────────────────────────────────────

const JWT_SECRET =
  process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");
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

// ── Anonymous registration ──────────────────────────────

/**
 * Register an anonymous user:
 *   - Client sends a deviceId (persistent per device)
 *   - Server generates a userId and returns a JWT
 */
export function registerAnonymous(deviceId: string): {
  token: string;
  userId: string;
} {
  const userId = `u_${crypto.randomBytes(8).toString("hex")}`;
  const token = signToken({ userId, deviceId });
  return { token, userId };
}
