/**
 * Workspace Sync Service
 *
 * Downloads remote project files to local storage via WebSocket.
 * Works through both direct server connections and Relay proxy.
 * Independent of useAgent — creates its own temporary WS connection.
 */

import { RelayClient } from "./relayClient";
import { writeLocalFile } from "./localFileSystem";
import type { AppSettings } from "../store/settings";

export interface SyncResult {
  success: boolean;
  fileCount?: number;
  error?: string;
}

interface FileItem {
  name: string;
  type: "file" | "directory";
}

/**
 * Sync remote workspace files to local storage.
 *
 * Determines the best connection method (Relay > Cloud > ToolServer),
 * opens a temporary WS connection, lists all remote files recursively,
 * downloads their content, and writes them to the local workspace.
 */
export async function syncRemoteToLocal(
  settings: AppSettings,
  projectId: string,
  localWorkspaceRoot?: string,
  onProgress?: (message: string) => void
): Promise<SyncResult> {
  // 1. Determine connection method
  const hasRelay =
    !!settings.relayToken &&
    !!settings.relayMachineId &&
    !!settings.relayServerUrl;
  const hasCloud = !!settings.cloudServerUrl;
  const hasTool = !!settings.toolServerUrl;

  if (!hasRelay && !hasCloud && !hasTool) {
    return { success: false, error: "没有可用的远程服务器配置" };
  }

  // 2. Create connection
  let ws: WebSocket | RelayClient;

  if (hasRelay) {
    onProgress?.("正在通过 Relay 连接到远程...");
    ws = new RelayClient({
      relayUrl: settings.relayServerUrl,
      machineId: settings.relayMachineId!,
      deviceId: settings.deviceId || `sync_${Date.now()}`,
      deviceName: "Pocket Code Sync",
      token: settings.relayToken,
    });
    (ws as RelayClient).connect();
  } else {
    const url = hasCloud ? settings.cloudServerUrl : settings.toolServerUrl;
    onProgress?.(`正在连接到 ${url}...`);
    ws = new WebSocket(url);
  }

  // 3. Wait for connection
  try {
    await waitForOpen(ws, 15000);
  } catch {
    closeWs(ws);
    return { success: false, error: "连接远程服务器超时" };
  }

  // 4. Set up message resolver
  const resolvers = new Map<
    string,
    { resolve: (data: any) => void; reject: (err: Error) => void }
  >();

  ws.onmessage = (event: { data: string } | MessageEvent) => {
    try {
      const data = JSON.parse(
        typeof event.data === "string" ? event.data : event.data.toString()
      );

      switch (data.type) {
        case "session":
          // Session established — resolve init waiter
          resolvers.get("__init__")?.resolve(data);
          resolvers.delete("__init__");
          break;

        case "auth": {
          // Server issued a token — send init after auth
          const authToken = data.token;
          sendInit(ws, projectId, authToken, settings);
          break;
        }

        case "file-list":
        case "file-content": {
          const reqId = data._reqId;
          if (reqId && resolvers.has(reqId)) {
            resolvers.get(reqId)!.resolve(data);
            resolvers.delete(reqId);
          }
          break;
        }

        case "error": {
          // Server error — reject init if waiting
          resolvers.get("__init__")?.reject(new Error(data.error));
          resolvers.delete("__init__");
          break;
        }
      }
    } catch {
      // Ignore parse errors
    }
  };

  // 5. Handshake: send init and wait for session
  try {
    onProgress?.("正在建立会话...");
    await initSession(ws, projectId, settings, resolvers);
  } catch (err: any) {
    closeWs(ws);
    return { success: false, error: `会话初始化失败: ${err.message}` };
  }

  // 6. Recursively list all remote files
  try {
    onProgress?.("正在扫描远程文件...");
    const allFiles = await listAllFiles(ws, resolvers, ".");

    if (allFiles.length === 0) {
      closeWs(ws);
      return { success: true, fileCount: 0 };
    }

    // 7. Download and write each file
    let written = 0;
    for (let i = 0; i < allFiles.length; i++) {
      const filePath = allFiles[i];
      onProgress?.(`正在同步 (${i + 1}/${allFiles.length}): ${filePath}`);

      try {
        const content = await readRemoteFile(ws, resolvers, filePath);
        if (content != null) {
          const result = await writeLocalFile(
            filePath,
            content,
            localWorkspaceRoot
          );
          if (result.success) written++;
        }
      } catch {
        // Skip files that fail to read/write
      }
    }

    closeWs(ws);
    return { success: true, fileCount: written };
  } catch (err: any) {
    closeWs(ws);
    return { success: false, error: err.message };
  }
}

// ── Internal helpers ────────────────────────────────────

function closeWs(ws: WebSocket | RelayClient) {
  try {
    if (ws instanceof RelayClient) {
      ws.close();
    } else {
      ws.close();
    }
  } catch {
    // Ignore close errors
  }
}

function waitForOpen(
  ws: WebSocket | RelayClient,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      reject(new Error("timeout"));
    }, timeoutMs);

    ws.onopen = () => {
      clearTimeout(timeout);
      resolve();
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("connection error"));
    };
  });
}

function sendInit(
  ws: WebSocket | RelayClient,
  projectId: string,
  authToken: string | undefined,
  settings: AppSettings
) {
  ws.send(
    JSON.stringify({
      type: "init",
      projectId,
      model: settings.defaultModel || "deepseek-v3",
      ...(authToken ? { token: authToken } : {}),
      gitCredentials:
        settings.gitCredentials?.filter((c) => c.token) || [],
    })
  );
}

function initSession(
  ws: WebSocket | RelayClient,
  projectId: string,
  settings: AppSettings,
  resolvers: Map<string, { resolve: (data: any) => void; reject: (err: Error) => void }>
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      resolvers.delete("__init__");
      reject(new Error("会话初始化超时"));
    }, 15000);

    resolvers.set("__init__", {
      resolve: (data) => {
        clearTimeout(timeout);
        resolve(data);
      },
      reject: (err) => {
        clearTimeout(timeout);
        reject(err);
      },
    });

    if (ws instanceof RelayClient) {
      // Relay mode: relay auth is handled by RelayClient internally
      // Just send init without authToken (daemon handles preAuth)
      ws.send(
        JSON.stringify({
          type: "init",
          projectId,
          model: settings.defaultModel || "deepseek-v3",
          gitCredentials:
            settings.gitCredentials?.filter((c) => c.token) || [],
        })
      );
    } else {
      // Direct server: send init with auth
      if (settings.authToken) {
        sendInit(ws, projectId, settings.authToken, settings);
      } else {
        // Register anonymously — the server will respond with "auth" type
        // which triggers sendInit in the onmessage handler
        const deviceId =
          settings.deviceId ||
          `dev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        ws.send(JSON.stringify({ type: "register", deviceId }));
      }
    }
  });
}

function makeReqId(): string {
  return `sync_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function requestWs(
  ws: WebSocket | RelayClient,
  resolvers: Map<string, { resolve: (data: any) => void; reject: (err: Error) => void }>,
  message: Record<string, unknown>,
  timeoutMs = 10000
): Promise<any> {
  return new Promise((resolve, reject) => {
    const reqId = makeReqId();
    const timeout = setTimeout(() => {
      resolvers.delete(reqId);
      reject(new Error("请求超时"));
    }, timeoutMs);

    resolvers.set(reqId, {
      resolve: (data) => {
        clearTimeout(timeout);
        resolve(data);
      },
      reject: (err) => {
        clearTimeout(timeout);
        reject(err);
      },
    });

    ws.send(JSON.stringify({ ...message, _reqId: reqId }));
  });
}

async function listAllFiles(
  ws: WebSocket | RelayClient,
  resolvers: Map<string, { resolve: (data: any) => void; reject: (err: Error) => void }>,
  rootPath: string
): Promise<string[]> {
  const allFiles: string[] = [];

  const listDir = async (dirPath: string) => {
    try {
      const res = await requestWs(ws, resolvers, {
        type: "list-files",
        path: dirPath,
      });

      const items: FileItem[] = res?.items || [];
      for (const item of items) {
        const fullPath =
          dirPath === "." ? item.name : `${dirPath}/${item.name}`;

        // Skip common large/unnecessary directories
        if (
          item.type === "directory" &&
          ["node_modules", ".git", "dist", "build", ".next"].includes(
            item.name
          )
        ) {
          continue;
        }

        if (item.type === "directory") {
          await listDir(fullPath);
        } else {
          allFiles.push(fullPath);
        }
      }
    } catch {
      // Skip inaccessible directories
    }
  };

  await listDir(rootPath);
  return allFiles;
}

async function readRemoteFile(
  ws: WebSocket | RelayClient,
  resolvers: Map<string, { resolve: (data: any) => void; reject: (err: Error) => void }>,
  filePath: string
): Promise<string | null> {
  const res = await requestWs(ws, resolvers, {
    type: "read-file",
    path: filePath,
  });

  if (res?.success && res.content != null) {
    return res.content;
  }
  return null;
}
