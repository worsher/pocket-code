// daemon 级后台进程注册表(单例)。按 workspace 分组管 startProcess 起的长驻进程。
// session TTL/断连不杀;同 workspace+同 command 再起先杀旧;daemon 退出 shutdownAll。
import { spawn as realSpawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { killProcessTree } from "@pocket-code/cli-agent";
import { isDockerEnabled } from "./docker.js";

export interface ManagedProcess {
  processId: string;
  workspace: string;
  command: string;
  pid: number;
  containerId?: string;
  startedAt: number;
}

type SpawnFn = typeof realSpawn;
let spawnFn: SpawnFn = realSpawn;
export function __setSpawnForTest(fn: SpawnFn | null): void {
  spawnFn = fn ?? realSpawn;
}

const registry = new Map<string, ManagedProcess>();
// 与 registry 同 key,存实际子进程句柄(host 分支 stop 时需直接信号句柄,不止 killProcessTree(pid))。
const handles = new Map<string, ChildProcess>();

function newId(): string {
  return "p_" + randomBytes(6).toString("hex");
}

export async function startManaged(
  workspace: string,
  command: string,
  opts?: { containerId?: string; cwd?: string; containerCwd?: string }
): Promise<{ processId: string }> {
  // 同 workspace+同 command 先杀旧(防堆积)
  for (const p of listManaged(workspace)) {
    if (p.command === command) await stopManaged(p.processId);
  }

  const processId = newId();
  const containerId = opts?.containerId;

  let child: ChildProcess;
  if (containerId && isDockerEnabled()) {
    const wArgs = opts?.containerCwd ? ["-w", opts.containerCwd] : [];
    child = spawnFn("docker", ["exec", "-d", ...wArgs, containerId, "sh", "-c", command], { stdio: "ignore" });
  } else {
    child = spawnFn(command, [], { cwd: opts?.cwd, shell: true, detached: true, stdio: "ignore" });
  }
  child.unref?.();

  const rec: ManagedProcess = {
    processId,
    workspace,
    command,
    pid: child.pid ?? -1,
    // 注:containerId 非空但 isDockerEnabled()=false 时,上面已退化走 host 分支,
    // 但此字段仍记原值。这是自洽的:stopManaged 用同一 `containerId && isDockerEnabled()`
    // 判据,届时同样走 host,不会误发 docker pkill。
    containerId,
    startedAt: Date.now(),
  };
  registry.set(processId, rec);
  handles.set(processId, child);

  child.on?.("close", () => { registry.delete(processId); handles.delete(processId); });
  child.on?.("error", () => { registry.delete(processId); handles.delete(processId); });

  return { processId };
}

export async function stopManaged(processId: string): Promise<void> {
  const rec = registry.get(processId);
  if (!rec) return;
  const child = handles.get(processId);
  registry.delete(processId);
  handles.delete(processId);
  if (rec.containerId && isDockerEnabled()) {
    // docker exec -d 拿不到容器内 pid,用容器内 pkill 按命令行匹配终止(docker 分支既定简化)
    try { spawnFn("docker", ["exec", rec.containerId, "pkill", "-f", rec.command], { stdio: "ignore" }); }
    catch { /* ignore */ }
    return;
  }
  // 直接信号句柄(测试可观察),再走 killProcessTree 兜底整棵进程树(shell:true 场景 child.kill 只杀 shell 本身)。
  try { child?.kill?.("SIGTERM"); } catch { /* ignore */ }
  if (rec.pid > 0) killProcessTree(rec.pid);
}

export function listManaged(workspace?: string): ManagedProcess[] {
  const all = [...registry.values()];
  return workspace ? all.filter((p) => p.workspace === workspace) : all;
}

export function shutdownAll(): void {
  for (const id of [...registry.keys()]) {
    // 同步尽力终止:不 await(退出钩子里)
    void stopManaged(id);
  }
  registry.clear();
  handles.clear();
}
