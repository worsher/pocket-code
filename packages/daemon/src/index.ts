// ── Daemon Entry Point ────────────────────────────────────
// Connects to a Relay server and handles forwarded requests
// from the mobile App, using the same message processing logic
// as the direct-connection server.

// 加载 .env:依次尝试 cwd → 包根 → 仓库根(已存在的变量不被覆盖)。
// pnpm --filter 运行时 cwd 是包目录,直接跑 dist 时 cwd 可能是仓库根,三级都兜住。
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join as joinPath } from "path";
loadEnv();
{
  const here = dirname(fileURLToPath(import.meta.url)); // src/ 或 dist/
  loadEnv({ path: joinPath(here, "..", ".env") });               // 包根
  loadEnv({ path: joinPath(here, "..", "..", "..", ".env") });   // 仓库根
}
import crypto from "crypto";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { startTunnelClient, type TunnelClientHandle } from "@pocket-code/tunnel-client";
import {
  generatePairingCode,
  verifyPairingCode,
  verifyDeviceToken,
  getPairingCodeInfo,
} from "./pairing.js";
import { loadDevices, getDevices } from "./deviceStore.js";
import { createMessageHandler, type MessageHandler } from "@pocket-code/server/messageHandler";
import { initDb } from "@pocket-code/server/db";
import { requireRelaySecret } from "./config.js";
import type { DaemonInboundType, ServerOutboundType } from "@pocket-code/wire";

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
    const id = crypto.randomBytes(8).toString("hex");
    mkdirSync(POCKET_HOME, { recursive: true });
    writeFileSync(path, id, { mode: 0o600 });
    return id;
  }
}

const MACHINE_ID = loadOrGenerateMachineId();

let RELAY_SECRET: string;
try {
  RELAY_SECRET = requireRelaySecret();
} catch (err: any) {
  console.error(`[Daemon] 启动失败:${err.message}`);
  process.exit(1);
}

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

const connection: TunnelClientHandle = startTunnelClient({
  relayUrl: RELAY_URL,
  machineId: MACHINE_ID,
  machineName: MACHINE_NAME,
  relaySecret: RELAY_SECRET,

  onConnected() {
    console.log("[Daemon] Registered with relay. Waiting for connections...");
  },

  onDisconnected() {
    console.log("[Daemon] Lost connection to relay.");
  },

  // 隧道帧由 tunnel-client 自消化;这里只接业务消息(pair-request/forward-request)
  onMessage(msg: DaemonInboundType) {
    handleRelayMessage(msg);
  },
});

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

function handleRelayMessage(msg: DaemonInboundType) {
  switch (msg.type) {
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

        const sendFn = (data: ServerOutboundType) => {
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
        // 出错时回 error 响应给 App,避免其挂起等待(审计:原先静默)。
        const sent = connection.send({
          type: "forward-response",
          requestId,
          payload: { type: "error", error: `Daemon handler error: ${err?.message ?? "unknown"}` },
        });
        if (!sent) {
          console.error("[Daemon] Failed to deliver error response (relay disconnected)");
        }
      });
      break;
    }

    default: {
      // DaemonInbound 已穷尽;此分支仅为将来 wire 扩展时的兜底日志
      console.log("[Daemon] Unhandled message from relay:", (msg as { type: string }).type);
    }
  }
}

// ── Graceful Shutdown ─────────────────────────────────

function shutdown() {
  console.log("\n[Daemon] Shutting down...");
  connection.stop();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
