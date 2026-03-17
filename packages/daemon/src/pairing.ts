// ── Pairing Module ────────────────────────────────────────
// Generates one-time pairing codes and issues device JWTs.
// Equivalent in purpose to happy's HANDY_MASTER_SECRET, but auto-generated.

import crypto from "crypto";
import jwt from "jsonwebtoken";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { addDevice, isDeviceAuthorized } from "./deviceStore.js";

// ── Daemon Secret ─────────────────────────────────────
// Auto-generated on first run, persisted to ~/.pocket-code/daemon-secret.
// This is the root of trust for all device JWTs.

const SECRET_DIR = resolve(
  process.env.POCKET_HOME || join(homedir(), ".pocket-code")
);
const SECRET_PATH = join(SECRET_DIR, "daemon-secret");

function loadOrGenerateSecret(): string {
  try {
    return readFileSync(SECRET_PATH, "utf-8").trim();
  } catch {
    const secret = crypto.randomBytes(32).toString("hex");
    mkdirSync(SECRET_DIR, { recursive: true });
    writeFileSync(SECRET_PATH, secret, { mode: 0o600 });
    console.log(`[Daemon] Generated and persisted daemon secret to ${SECRET_PATH}`);
    return secret;
  }
}

const DAEMON_SECRET = loadOrGenerateSecret();

// ── Pairing Code ──────────────────────────────────────

interface PairingCodeEntry {
  code: string;
  createdAt: number;
  expiresAt: number;
  used: boolean;
  failedAttempts: number;
}

let activePairingCode: PairingCodeEntry | null = null;

const PAIRING_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_PAIRING_FAILURES = 5;

// Character set: 0-9, A-H, J-N, P-Z (excludes I and O to avoid confusion)
const PAIRING_CHARSET = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // 34 chars
const PAIRING_CODE_LENGTH = 8;

/**
 * Generate a new 8-character alphanumeric pairing code.
 * Uses a charset that excludes I and O to avoid confusion.
 * Replaces any previously active code.
 */
export function generatePairingCode(): string {
  let code = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    code += PAIRING_CHARSET[crypto.randomInt(PAIRING_CHARSET.length)];
  }
  activePairingCode = {
    code,
    createdAt: Date.now(),
    expiresAt: Date.now() + PAIRING_CODE_TTL_MS,
    used: false,
    failedAttempts: 0,
  };
  return code;
}

/**
 * Verify a pairing code and return a device JWT if valid.
 * The code is consumed (marked as used) on success.
 */
export function verifyPairingCode(
  code: string,
  deviceId: string,
  deviceName: string,
  machineId: string
): { success: true; token: string } | { success: false; error: string } {
  if (!activePairingCode) {
    return { success: false, error: "No active pairing code. Restart the daemon to generate a new one." };
  }

  if (activePairingCode.used) {
    return { success: false, error: "Pairing code has already been used." };
  }

  if (Date.now() > activePairingCode.expiresAt) {
    activePairingCode = null;
    return { success: false, error: "Pairing code has expired. Restart the daemon to generate a new one." };
  }

  if (activePairingCode.code !== code) {
    activePairingCode.failedAttempts++;
    if (activePairingCode.failedAttempts >= MAX_PAIRING_FAILURES) {
      console.log(`[Daemon] Pairing code destroyed after ${MAX_PAIRING_FAILURES} failed attempts`);
      activePairingCode = null;
      return { success: false, error: "Too many failed attempts. Pairing code has been invalidated. Generate a new one." };
    }
    return { success: false, error: `Invalid pairing code. ${MAX_PAIRING_FAILURES - activePairingCode.failedAttempts} attempt(s) remaining.` };
  }

  // ✅ Code is valid — mark as used
  activePairingCode.used = true;

  // Register the device
  addDevice(deviceId, deviceName);

  // Issue a long-lived JWT for this device
  const token = issueDeviceToken(deviceId, deviceName, machineId);

  console.log(`[Daemon] Device paired successfully: ${deviceName} (${deviceId})`);

  return { success: true, token };
}

// ── Device JWT ────────────────────────────────────────

export interface DeviceTokenPayload {
  deviceId: string;
  deviceName: string;
  machineId: string;
  iat: number;
  exp: number;
}

function issueDeviceToken(
  deviceId: string,
  deviceName: string,
  machineId: string
): string {
  return jwt.sign(
    { deviceId, deviceName, machineId },
    DAEMON_SECRET,
    { expiresIn: "365d" }
  );
}

/**
 * Verify a device JWT. Returns the payload if valid and the device is not revoked.
 */
export function verifyDeviceToken(
  token: string
): DeviceTokenPayload | null {
  try {
    const payload = jwt.verify(token, DAEMON_SECRET) as DeviceTokenPayload;

    // Check if the device has been revoked
    if (!isDeviceAuthorized(payload.deviceId)) {
      console.log(`[Daemon] Device ${payload.deviceId} is revoked, rejecting token`);
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

/** Get the current active pairing code info (for display) */
export function getPairingCodeInfo(): {
  code: string;
  expiresAt: number;
  used: boolean;
} | null {
  if (!activePairingCode || activePairingCode.used) return null;
  if (Date.now() > activePairingCode.expiresAt) return null;
  return {
    code: activePairingCode.code,
    expiresAt: activePairingCode.expiresAt,
    used: activePairingCode.used,
  };
}
