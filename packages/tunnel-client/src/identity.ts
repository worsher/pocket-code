// ── CLI 身份持久化(对齐 daemon 的 ~/.pocket-code/machine-id 模式) ──

import crypto from "crypto";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { homedir, hostname } from "os";

export interface TunnelIdentity {
  machineId: string;
  machineName: string;
}

export function loadOrCreateIdentity(
  filePath: string = join(homedir(), ".pocket-tunnel.json"),
  defaultName: string = hostname()
): TunnelIdentity {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
    if (parsed && typeof parsed.machineId === "string" && parsed.machineId) {
      return {
        machineId: parsed.machineId,
        machineName:
          typeof parsed.machineName === "string" && parsed.machineName ? parsed.machineName : defaultName,
      };
    }
  } catch {
    /* 首次运行或损坏:重建 */
  }
  const identity: TunnelIdentity = {
    machineId: `m_${crypto.randomBytes(8).toString("hex")}`,
    machineName: defaultName,
  };
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(identity, null, 2), { mode: 0o600 });
  return identity;
}
