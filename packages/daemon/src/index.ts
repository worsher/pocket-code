// ── Daemon Entry Point ────────────────────────────────────
// Connects to a Relay server and handles forwarded requests
// from the mobile App, using the same message processing logic
// as the direct-connection server.

import crypto from "crypto";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { RelayConnection } from "./connection.js";
import {
  generatePairingCode,
  verifyPairingCode,
  verifyDeviceToken,
  getPairingCodeInfo,
} from "./pairing.js";
import { loadDevices, getDevices } from "./deviceStore.js";
import { createMessageHandler, type MessageHandler } from "@pocket-code/server/messageHandler";
import { initDb } from "@pocket-code/server/db";

// ── Configuration ─────────────────────────────────────

const RELAY_URL = process.env.RELAY_URL || "ws://localhost:3200";
const MACHINE_NAME = process.env.MACHINE_NAME || hostname();

function hostname(): string {
  try {
    return require("os").hostname();
  } catch {
    return "daemon";
  }
}

// Machine ID: persisted per machine so it's stable across restarts
const POCKET_HOME = resolve(
  process.env.POCKET_HOME || join(homedir(), ".pocket-code")
);

function loadOrGenerateMachineId(): string {
  const path = join(POCKET_HOME, "machine-id");
  try {
    return readFileSync(path, "utf-8").trim();
  } catch {
    const id = `m_${crypto.randomBytes(8).toString("hex")}`;
    mkdirSync(POCKET_HOME, { recursive: true });
    writeFileSync(path, id, { mode: 0o600 });
    return id;
  }
}

const MACHINE_ID = loadOrGenerateMachineId();

// ── Initialize ────────────────────────────────────────

// Initialize database (required by messageHandler's session/auth logic)
await initDb();

// Load previously authorized devices
loadDevices();

// Generate a fresh pairing code
let currentPairingCode = generatePairingCode();

function printPairingCode(code: string) {
  console.log("");
  console.log("╔══════════════════════════════════════════╗");
  console.log(`║  Pairing Code:  ${code.padEnd(24)}║`);
  console.log(`║  Expires in 5 minutes                    ║`);
  console.log("╚══════════════════════════════════════════╝");
  console.log("");
}

console.log("");
console.log("╔══════════════════════════════════════════╗");
console.log("║       Pocket Code Daemon                 ║");
console.log("╠══════════════════════════════════════════╣");
console.log(`║  Machine:  ${MACHINE_NAME.padEnd(29)}║`);
console.log(`║  ID:       ${MACHINE_ID.padEnd(29)}║`);
console.log(`║  Relay:    ${RELAY_URL.padEnd(29)}║`);
console.log("╚══════════════════════════════════════════╝");
printPairingCode(currentPairingCode);

// Auto-refresh pairing code when it expires (every 5 minutes)
setInterval(() => {
  const info = getPairingCodeInfo();
  if (!info) {
    // Code expired or was used — generate a new one
    currentPairingCode = generatePairingCode();
    console.log("[Daemon] Pairing code expired, generated new one:");
    printPairingCode(currentPairingCode);
  }
}, 30 * 1000); // Check every 30 seconds

// Show authorized devices
const devices = getDevices();
if (devices.length > 0) {
  console.log(`[Daemon] ${devices.filter((d) => !d.revoked).length} authorized device(s):`);
  for (const d of devices) {
    const status = d.revoked ? "❌ revoked" : "✅ active";
    console.log(`  - ${d.deviceName} (${d.deviceId.slice(0, 8)}…) ${status}`);
  }
  console.log("");
}

// ── Connect to Relay ──────────────────────────────────

const connection = new RelayConnection({
  relayUrl: RELAY_URL,
  machineId: MACHINE_ID,
  machineName: MACHINE_NAME,

  onConnected() {
    console.log("[Daemon] Registered with relay. Waiting for connections...");
  },

  onDisconnected() {
    console.log("[Daemon] Lost connection to relay.");
  },

  onMessage(msg: any) {
    handleRelayMessage(msg);
  },
});

connection.connect();

// ── Device Handler Pool ──────────────────────────────
// Maintain one handler per device so session/auth state persists across requests.

interface DeviceHandlerEntry {
  handler: MessageHandler;
  lastActivity: number;
  currentRequestId: string;
}

const deviceHandlers = new Map<string, DeviceHandlerEntry>();

const HANDLER_TTL_MS = 30 * 60 * 1000; // 30 minutes (matches server session TTL)

// Periodic cleanup of idle handlers
setInterval(() => {
  const now = Date.now();
  for (const [deviceId, entry] of deviceHandlers) {
    if (now - entry.lastActivity > HANDLER_TTL_MS) {
      console.log(`[Daemon] Cleaning up idle handler for device: ${deviceId}`);
      entry.handler.onClose();
      deviceHandlers.delete(deviceId);
    }
  }
}, 5 * 60 * 1000);

// ── Message Handler ───────────────────────────────────

function handleRelayMessage(msg: any) {
  switch (msg.type) {
    case "daemon-registered": {
      console.log("[Daemon] Registration confirmed by relay");
      break;
    }

    // ── Pairing request from App ──────────────────
    case "pair-request": {
      console.log(
        `[Daemon] Pair request from device: ${msg.deviceName} (code: ${msg.pairingCode})`
      );

      const result = verifyPairingCode(
        msg.pairingCode,
        msg.deviceId,
        msg.deviceName,
        MACHINE_ID
      );

      if (result.success) {
        connection.send({
          type: "pair-response",
          success: true,
          token: result.token,
          machineId: MACHINE_ID,
          machineName: MACHINE_NAME,
        });
        console.log(`[Daemon] ✅ Device ${msg.deviceName} paired successfully!`);

        // Generate a new pairing code for next pairing
        const newCode = generatePairingCode();
        console.log(`[Daemon] 📱 New pairing code: ${newCode}`);
      } else {
        connection.send({
          type: "pair-response",
          success: false,
          error: result.error,
        });
        console.log(`[Daemon] ❌ Pairing failed: ${result.error}`);
      }
      break;
    }

    // ── Forwarded business request from App ───────
    case "forward-request": {
      const { token, requestId, payload } = msg;

      // Verify the device JWT
      const device = verifyDeviceToken(token);
      if (!device) {
        connection.send({
          type: "forward-response",
          requestId,
          payload: { type: "error", error: "Unauthorized: invalid or revoked device token" },
        });
        return;
      }

      console.log(
        `[Daemon] Request from ${device.deviceName}: ${payload?.type} (${requestId.slice(0, 8)}…)`
      );

      // Get or create a handler for this device (maintains session state across requests)
      let entry = deviceHandlers.get(device.deviceId);
      if (!entry) {
        // Create handler entry first so send callback can reference it
        const newEntry: DeviceHandlerEntry = {
          handler: null as any, // will be set below
          lastActivity: Date.now(),
          currentRequestId: requestId,
        };

        const sendFn = (data: any) => {
          // Dynamically use the current requestId from the entry
          connection.send({
            type: "forward-stream",
            requestId: newEntry.currentRequestId,
            payload: data,
          });
        };

        newEntry.handler = createMessageHandler(sendFn, {
          preAuth: {
            userId: `relay_${device.deviceId}`,
            deviceId: device.deviceId,
          },
        });

        deviceHandlers.set(device.deviceId, newEntry);
        entry = newEntry;
      }

      // Update the current requestId and activity timestamp
      entry.currentRequestId = requestId;
      entry.lastActivity = Date.now();

      // Pass the payload to the handler
      entry.handler.onMessage(JSON.stringify(payload)).catch((err: any) => {
        console.error("[Daemon] Error handling forwarded message:", err);
      });
      break;
    }

    case "error": {
      console.error("[Daemon] Relay error:", msg.error);
      break;
    }

    default: {
      console.log("[Daemon] Unknown message from relay:", msg.type);
    }
  }
}

// ── Graceful Shutdown ─────────────────────────────────

function shutdown() {
  console.log("\n[Daemon] Shutting down...");
  connection.disconnect();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
