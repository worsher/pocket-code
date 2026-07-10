#!/usr/bin/env node
// ── pocket-tunnel:最小隧道客户端 CLI(tunnel-only,不含 agent/配对业务) ──
// 用法:pocket-tunnel --relay wss://host/relay --secret <RELAY_SECRET> [--name my-machine]
// env 兜底:RELAY_URL / RELAY_SECRET / MACHINE_NAME

import { config as loadEnv } from "dotenv";
loadEnv();
import { loadOrCreateIdentity } from "./identity.js";
import { startTunnelClient } from "./client.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : undefined;
}

const relayUrl = arg("relay") || process.env.RELAY_URL || "";
const relaySecret = arg("secret") || process.env.RELAY_SECRET || "";
if (!relayUrl || !relaySecret) {
  console.error("用法:pocket-tunnel --relay wss://host/relay --secret <RELAY_SECRET> [--name my-machine]");
  console.error("(或设置环境变量 RELAY_URL / RELAY_SECRET)");
  process.exit(1);
}

const identity = loadOrCreateIdentity();
const machineName = arg("name") || process.env.MACHINE_NAME || identity.machineName;

console.log(`[Tunnel] machineId=${identity.machineId} name=${machineName}`);
console.log(`[Tunnel] 隧道入口:<relay-http-origin>/t/${identity.machineId}/<本机端口>/`);

const handle = startTunnelClient({
  relayUrl,
  relaySecret,
  machineId: identity.machineId,
  machineName,
  onConnected: () => console.log("[Tunnel] Registered with relay."),
  onDisconnected: () => console.log("[Tunnel] Disconnected from relay; reconnecting..."),
});

const shutdown = () => {
  handle.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
