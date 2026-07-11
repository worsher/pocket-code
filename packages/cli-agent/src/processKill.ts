// 跨平台进程树终止(从 cli/runner.ts 提取,供 runner 与 processRegistry 共用)。
// 先 SIGTERM,grace 后 SIGKILL(用进程组信号 -pid);win32 走 taskkill /T。
import { spawn as nodeSpawn } from "node:child_process";

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function killProcessTree(pid: number, graceMs = 3000): void {
  if (!Number.isFinite(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    try {
      nodeSpawn("taskkill", ["/T", "/PID", String(pid)], { stdio: "ignore", detached: true });
    } catch { /* ignore */ }
    setTimeout(() => {
      if (!isProcessAlive(pid)) return;
      try {
        nodeSpawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", detached: true });
      } catch { /* ignore */ }
    }, graceMs).unref();
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try { process.kill(pid, "SIGTERM"); } catch { return; }
  }
  setTimeout(() => {
    if (isProcessAlive(-pid)) {
      try { process.kill(-pid, "SIGKILL"); return; } catch { /* fall through */ }
    }
    if (isProcessAlive(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }, graceMs).unref();
}
