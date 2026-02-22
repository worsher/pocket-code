// ── Container Pool Management ────────────────────────────
// Pre-warms Docker containers for faster assignment and manages
// the lifecycle: warming → ready → assigned → cooling → removed.

import Docker from "dockerode";

const docker = new Docker();

const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || "pocket-code-sandbox:latest";
const POOL_MIN_READY = parseInt(process.env.POOL_MIN_READY || "3", 10);
const POOL_MAX_TOTAL = parseInt(process.env.POOL_MAX_TOTAL || "20", 10);
const POOL_WARMUP_BATCH = parseInt(process.env.POOL_WARMUP_BATCH || "2", 10);
const POOL_MAINTENANCE_INTERVAL = parseInt(process.env.POOL_MAINTENANCE_INTERVAL || "30000", 10);
const POOL_IDLE_TIMEOUT = parseInt(process.env.POOL_IDLE_TIMEOUT || "300000", 10); // 5min
const POOL_MEMORY = parseInt(process.env.POOL_MEMORY || "536870912", 10); // 512MB default
const POOL_CPU = parseFloat(process.env.POOL_CPU || "0.5");
const WORKSPACE_BASE = process.env.WORKSPACE_BASE || "/tmp/pocket-code-workspaces";

// ── Types ────────────────────────────────────────────────

type PoolState = "warming" | "ready" | "assigned" | "cooling";

interface PooledContainer {
  containerId: string;
  state: PoolState;
  userId?: string;
  workspace?: string;
  createdAt: number;
  lastActive: number;
}

// ── Pool State ───────────────────────────────────────────

const pool = new Map<string, PooledContainer>();
let maintenanceTimer: ReturnType<typeof setInterval> | null = null;
let initialized = false;

// ── Public API ───────────────────────────────────────────

export function isPoolEnabled(): boolean {
  return process.env.POOL_ENABLED === "true";
}

/**
 * Initialize the container pool.
 * Pre-warms POOL_MIN_READY containers and starts maintenance loop.
 */
export async function initPool(): Promise<void> {
  if (initialized) return;
  initialized = true;

  console.log(`[Pool] Initializing (min_ready=${POOL_MIN_READY}, max=${POOL_MAX_TOTAL})`);

  // Pre-warm initial containers
  await warmupContainers(POOL_MIN_READY);

  // Start maintenance loop
  maintenanceTimer = setInterval(runMaintenance, POOL_MAINTENANCE_INTERVAL);
}

/**
 * Acquire a container from the pool for a user.
 * Returns the container ID.
 */
export async function acquireContainer(
  userId: string,
  workspace: string,
  memoryBytes?: number,
  nanoCpus?: number
): Promise<string> {
  // Check if user already has an assigned container
  for (const [, entry] of pool) {
    if (entry.state === "assigned" && entry.userId === userId) {
      entry.lastActive = Date.now();
      entry.workspace = workspace;
      return entry.containerId;
    }
  }

  // Try to get a ready container
  let readyEntry: PooledContainer | null = null;
  for (const [, entry] of pool) {
    if (entry.state === "ready") {
      readyEntry = entry;
      break;
    }
  }

  if (readyEntry) {
    readyEntry.state = "assigned";
    readyEntry.userId = userId;
    readyEntry.workspace = workspace;
    readyEntry.lastActive = Date.now();

    // Bind workspace to container
    try {
      await bindWorkspace(readyEntry.containerId, workspace);
    } catch (err: any) {
      console.error(`[Pool] Failed to bind workspace: ${err.message}`);
      // Remove broken container and create a fresh one
      await removePooledContainer(readyEntry.containerId);
      return createAssignedContainer(userId, workspace, memoryBytes, nanoCpus);
    }

    console.log(`[Pool] Assigned ${readyEntry.containerId.slice(0, 12)} to user ${userId}`);
    return readyEntry.containerId;
  }

  // No ready containers — check if we can create one
  if (pool.size >= POOL_MAX_TOTAL) {
    // Evict oldest cooling container
    let oldestCooling: PooledContainer | null = null;
    for (const [, entry] of pool) {
      if (entry.state === "cooling") {
        if (!oldestCooling || entry.lastActive < oldestCooling.lastActive) {
          oldestCooling = entry;
        }
      }
    }
    if (oldestCooling) {
      await removePooledContainer(oldestCooling.containerId);
    } else {
      throw new Error("Container pool exhausted");
    }
  }

  return createAssignedContainer(userId, workspace, memoryBytes, nanoCpus);
}

/**
 * Release a user's container back to cooling state.
 */
export async function releaseContainer(userId: string): Promise<void> {
  for (const [, entry] of pool) {
    if (entry.state === "assigned" && entry.userId === userId) {
      entry.state = "cooling";
      entry.lastActive = Date.now();
      entry.userId = undefined;
      console.log(`[Pool] Released ${entry.containerId.slice(0, 12)} to cooling`);
      break;
    }
  }
}

/**
 * Get pool statistics.
 */
export function getPoolStats(): {
  total: number;
  warming: number;
  ready: number;
  assigned: number;
  cooling: number;
} {
  let warming = 0, ready = 0, assigned = 0, cooling = 0;
  for (const [, entry] of pool) {
    switch (entry.state) {
      case "warming": warming++; break;
      case "ready": ready++; break;
      case "assigned": assigned++; break;
      case "cooling": cooling++; break;
    }
  }
  return { total: pool.size, warming, ready, assigned, cooling };
}

/** Shutdown the pool (graceful) */
export async function shutdownPool(): Promise<void> {
  if (maintenanceTimer) {
    clearInterval(maintenanceTimer);
    maintenanceTimer = null;
  }

  console.log(`[Pool] Shutting down ${pool.size} containers...`);
  const removePromises: Promise<void>[] = [];
  for (const [containerId] of pool) {
    removePromises.push(removePooledContainer(containerId));
  }
  await Promise.allSettled(removePromises);
  initialized = false;
}

// ── Internal ─────────────────────────────────────────────

async function createWarmContainer(): Promise<string> {
  const container = await docker.createContainer({
    Image: SANDBOX_IMAGE,
    name: `pocket-pool-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    HostConfig: {
      Memory: POOL_MEMORY,
      NanoCpus: Math.floor(POOL_CPU * 1e9),
      NetworkMode: "bridge",
      ReadonlyRootfs: false,
      SecurityOpt: ["no-new-privileges"],
    },
    WorkingDir: "/workspace",
    Tty: false,
    OpenStdin: false,
  });

  await container.start();
  return container.id;
}

async function createAssignedContainer(
  userId: string,
  workspace: string,
  memoryBytes?: number,
  nanoCpus?: number
): Promise<string> {
  const container = await docker.createContainer({
    Image: SANDBOX_IMAGE,
    name: `pocket-code-${userId}-${Date.now()}`,
    HostConfig: {
      Binds: [`${workspace}:/workspace`],
      Memory: memoryBytes || POOL_MEMORY,
      NanoCpus: nanoCpus || Math.floor(POOL_CPU * 1e9),
      NetworkMode: "bridge",
      ReadonlyRootfs: false,
      SecurityOpt: ["no-new-privileges"],
    },
    WorkingDir: "/workspace",
    Tty: false,
    OpenStdin: false,
  });

  await container.start();

  pool.set(container.id, {
    containerId: container.id,
    state: "assigned",
    userId,
    workspace,
    createdAt: Date.now(),
    lastActive: Date.now(),
  });

  console.log(`[Pool] Created assigned container ${container.id.slice(0, 12)} for user ${userId}`);
  return container.id;
}

async function bindWorkspace(containerId: string, workspace: string): Promise<void> {
  // For pre-warmed containers without volume mounts, we copy files
  // via exec. A simpler approach: exec `ln -sfn` to symlink.
  const container = docker.getContainer(containerId);
  const exec = await container.exec({
    Cmd: ["sh", "-c", `rm -rf /workspace && ln -sfn ${workspace} /workspace`],
    AttachStdout: true,
    AttachStderr: true,
  });
  await new Promise<void>((resolve, reject) => {
    exec.start({ Tty: false }, (err: Error | null, stream: NodeJS.ReadableStream | undefined) => {
      if (err) { reject(err); return; }
      if (!stream) { reject(new Error("No stream")); return; }
      stream.on("end", () => resolve());
      stream.on("error", reject);
      stream.resume(); // drain
    });
  });
}

async function warmupContainers(count: number): Promise<void> {
  const promises: Promise<void>[] = [];
  for (let i = 0; i < count; i++) {
    promises.push(
      (async () => {
        try {
          const id = await createWarmContainer();
          pool.set(id, {
            containerId: id,
            state: "ready",
            createdAt: Date.now(),
            lastActive: Date.now(),
          });
          console.log(`[Pool] Warmed container ${id.slice(0, 12)}`);
        } catch (err: any) {
          console.error(`[Pool] Failed to warm container: ${err.message}`);
        }
      })()
    );
  }
  await Promise.allSettled(promises);
}

async function removePooledContainer(containerId: string): Promise<void> {
  pool.delete(containerId);
  try {
    const container = docker.getContainer(containerId);
    await container.stop({ t: 2 }).catch(() => {});
    await container.remove({ force: true }).catch(() => {});
  } catch {
    // ignore
  }
}

async function runMaintenance(): Promise<void> {
  const now = Date.now();
  const stats = getPoolStats();

  // Remove idle cooling containers
  for (const [containerId, entry] of pool) {
    if (entry.state === "cooling" && now - entry.lastActive > POOL_IDLE_TIMEOUT) {
      await removePooledContainer(containerId);
    }
  }

  // Replenish ready pool
  const readyCount = getPoolStats().ready;
  if (readyCount < POOL_MIN_READY && pool.size < POOL_MAX_TOTAL) {
    const needed = Math.min(
      POOL_MIN_READY - readyCount,
      POOL_MAX_TOTAL - pool.size,
      POOL_WARMUP_BATCH
    );
    if (needed > 0) {
      await warmupContainers(needed);
    }
  }

  // Remove excessively old containers (> 1 hour idle in ready state)
  for (const [containerId, entry] of pool) {
    if (entry.state === "ready" && now - entry.lastActive > 3600000) {
      await removePooledContainer(containerId);
    }
  }
}
