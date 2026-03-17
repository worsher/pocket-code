// ── Device Store ──────────────────────────────────────────
// Persists authorized devices to a JSON file so they survive daemon restarts.

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";

export interface AuthorizedDevice {
  deviceId: string;
  deviceName: string;
  authorizedAt: number;
  /** Set to true to revoke this device without removing from the list */
  revoked?: boolean;
}

const STORE_DIR = resolve(
  process.env.POCKET_HOME || join(homedir(), ".pocket-code")
);
const STORE_PATH = join(STORE_DIR, "authorized-devices.json");

let devices: AuthorizedDevice[] = [];

/** Load devices from disk */
export function loadDevices(): AuthorizedDevice[] {
  try {
    const data = readFileSync(STORE_PATH, "utf-8");
    devices = JSON.parse(data);
  } catch {
    devices = [];
  }
  return devices;
}

/** Save devices to disk */
function saveDevices(): void {
  mkdirSync(STORE_DIR, { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(devices, null, 2), {
    mode: 0o600,
  });
}

/** Add a newly authorized device */
export function addDevice(deviceId: string, deviceName: string): void {
  // Remove previous entry for same deviceId (re-pairing)
  devices = devices.filter((d) => d.deviceId !== deviceId);
  devices.push({
    deviceId,
    deviceName,
    authorizedAt: Date.now(),
  });
  saveDevices();
}

/** Check if a device is authorized (not revoked) */
export function isDeviceAuthorized(deviceId: string): boolean {
  return devices.some((d) => d.deviceId === deviceId && !d.revoked);
}

/** Revoke a device */
export function revokeDevice(deviceId: string): boolean {
  const device = devices.find((d) => d.deviceId === deviceId);
  if (!device) return false;
  device.revoked = true;
  saveDevices();
  return true;
}

/** Get all devices (for status display) */
export function getDevices(): AuthorizedDevice[] {
  return [...devices];
}
