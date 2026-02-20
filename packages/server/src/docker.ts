import Docker from "dockerode";

const docker = new Docker();

const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || "pocket-code-sandbox:latest";
const CONTAINER_MEMORY = parseInt(process.env.CONTAINER_MEMORY || "536870912", 10); // 512MB
const CONTAINER_CPU = parseFloat(process.env.CONTAINER_CPU || "0.5");
const IDLE_STOP_MS = parseInt(process.env.IDLE_STOP_MS || "300000", 10); // 5 min
const IDLE_REMOVE_MS = parseInt(process.env.IDLE_REMOVE_MS || "1800000", 10); // 30 min

// ── Container State ─────────────────────────────────────

interface ContainerInfo {
  containerId: string;
  userId: string;
  workspace: string;
  lastActive: number;
}

const containers = new Map<string, ContainerInfo>();
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

// ── Public API ──────────────────────────────────────────

/** Whether Docker isolation is enabled */
export function isDockerEnabled(): boolean {
  return process.env.DOCKER_ENABLED === "true";
}

/**
 * Get or create a container for the given user.
 * The host workspace directory is mounted to /workspace in the container.
 */
export async function getContainer(
  userId: string,
  workspace: string
): Promise<string> {
  const existing = containers.get(userId);
  if (existing) {
    existing.lastActive = Date.now();
    // Ensure container is running
    try {
      const container = docker.getContainer(existing.containerId);
      const info = await container.inspect();
      if (info.State.Running) {
        return existing.containerId;
      }
      // Container stopped — restart it
      await container.start();
      return existing.containerId;
    } catch {
      // Container gone — recreate
      containers.delete(userId);
    }
  }

  // Create new container
  const container = await docker.createContainer({
    Image: SANDBOX_IMAGE,
    name: `pocket-code-${userId}-${Date.now()}`,
    HostConfig: {
      Binds: [`${workspace}:/workspace`],
      Memory: CONTAINER_MEMORY,
      NanoCpus: Math.floor(CONTAINER_CPU * 1e9),
      NetworkMode: "bridge",
      // Security
      ReadonlyRootfs: false,
      SecurityOpt: ["no-new-privileges"],
    },
    WorkingDir: "/workspace",
    Tty: false,
    OpenStdin: false,
  });

  await container.start();

  containers.set(userId, {
    containerId: container.id,
    userId,
    workspace,
    lastActive: Date.now(),
  });

  console.log(`[Docker] Created container for user ${userId}: ${container.id.slice(0, 12)}`);
  startCleanupLoop();
  return container.id;
}

/**
 * Execute a command inside the user's container.
 * Returns { stdout, stderr, exitCode }.
 */
export async function execInContainer(
  containerId: string,
  command: string,
  options: {
    cwd?: string;
    timeout?: number;
    env?: Record<string, string>;
  } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const container = docker.getContainer(containerId);

  const env = Object.entries(options.env || {}).map(
    ([k, v]) => `${k}=${v}`
  );

  const exec = await container.exec({
    Cmd: ["bash", "-c", command],
    WorkingDir: options.cwd || "/workspace",
    Env: env.length > 0 ? env : undefined,
    AttachStdout: true,
    AttachStderr: true,
  });

  return new Promise((resolve, reject) => {
    const timeout = options.timeout || 30000;
    let timer: ReturnType<typeof setTimeout> | null = null;

    exec.start({ Tty: false }, (err: Error | null, stream: NodeJS.ReadableStream | undefined) => {
      if (err || !stream) {
        reject(err || new Error("Failed to start exec"));
        return;
      }

      let stdout = "";
      let stderr = "";

      // Docker multiplexes stdout and stderr in one stream.
      // Each frame: [type(1 byte), 0, 0, size(4 bytes BE), payload]
      // type: 1 = stdout, 2 = stderr
      stream.on("data", (chunk: Buffer) => {
        let offset = 0;
        while (offset < chunk.length) {
          if (offset + 8 > chunk.length) {
            // Partial header — treat remaining as stdout
            stdout += chunk.subarray(offset).toString("utf-8");
            break;
          }
          const type = chunk[offset];
          const size = chunk.readUInt32BE(offset + 4);
          const payload = chunk.subarray(offset + 8, offset + 8 + size).toString("utf-8");
          if (type === 2) {
            stderr += payload;
          } else {
            stdout += payload;
          }
          offset += 8 + size;
        }
      });

      stream.on("end", async () => {
        if (timer) clearTimeout(timer);
        try {
          const inspectResult = await exec.inspect();
          resolve({
            stdout: stdout.slice(0, 1024 * 1024), // 1MB limit
            stderr: stderr.slice(0, 512 * 1024),
            exitCode: inspectResult.ExitCode ?? 0,
          });
        } catch {
          resolve({ stdout, stderr, exitCode: -1 });
        }
      });

      stream.on("error", (e: Error) => {
        if (timer) clearTimeout(timer);
        reject(e);
      });

      timer = setTimeout(() => {
        if ("destroy" in stream && typeof (stream as any).destroy === "function") {
          (stream as any).destroy();
        }
        reject(new Error(`Command timed out after ${timeout}ms`));
      }, timeout);
    });
  });
}

/** Remove a user's container */
export async function removeContainer(userId: string): Promise<void> {
  const info = containers.get(userId);
  if (!info) return;
  try {
    const container = docker.getContainer(info.containerId);
    await container.stop({ t: 2 }).catch(() => {});
    await container.remove({ force: true }).catch(() => {});
    console.log(`[Docker] Removed container for user ${userId}`);
  } catch {
    // Ignore errors
  }
  containers.delete(userId);
}

// ── Idle cleanup ────────────────────────────────────────

function startCleanupLoop() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(async () => {
    const now = Date.now();
    for (const [userId, info] of containers) {
      const idle = now - info.lastActive;
      if (idle > IDLE_REMOVE_MS) {
        await removeContainer(userId);
      } else if (idle > IDLE_STOP_MS) {
        try {
          const container = docker.getContainer(info.containerId);
          const state = await container.inspect();
          if (state.State.Running) {
            await container.stop({ t: 2 });
            console.log(`[Docker] Stopped idle container for user ${userId}`);
          }
        } catch {
          containers.delete(userId);
        }
      }
    }
    // Stop loop if no containers left
    if (containers.size === 0 && cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
  }, 60000); // Check every minute
}
