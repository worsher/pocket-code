// ── Relay Core ────────────────────────────────────────────
// Manages daemon connections, routes messages between App and Daemon,
// and forwards pairing requests/responses.

import { WebSocket } from "ws";
import { relayLog } from "./log.js";

// ── Types ─────────────────────────────────────────────

interface DaemonConnection {
  socket: WebSocket;
  machineId: string;
  machineName: string;
  lastHeartbeat: number;
  publicKey?: string;
  keyId?: string;
}

interface PendingPairRequest {
  appSocket: WebSocket;
  requestedAt: number;
}

// ── Relay State ───────────────────────────────────────

/** machineId → DaemonConnection */
const daemons = new Map<string, DaemonConnection>();

/** machineId → pending pair requests from apps (waiting for daemon response) */
const pendingPairs = new Map<string, PendingPairRequest[]>();

// ── Daemon Management ─────────────────────────────────

export function registerDaemon(
  socket: WebSocket,
  machineId: string,
  machineName: string,
  publicKey?: string,
  keyId?: string
): WebSocket | undefined {
  // Atomically replace the registry owner before closing the old socket. Some
  // WebSocket implementations can emit close synchronously; the late callback
  // must already observe that the old socket is no longer authoritative.
  const existing = daemons.get(machineId);
  const replacedSocket = existing?.socket !== socket ? existing?.socket : undefined;

  daemons.set(machineId, {
    socket,
    machineId,
    machineName,
    lastHeartbeat: Date.now(),
    publicKey,
    keyId,
  });

  if (replacedSocket) {
    console.log(`[Relay] Replacing existing daemon connection for ${machineId}`);
    try {
      replacedSocket.close(1000, "Replaced by new connection");
    } catch {
      // Ignore close errors on stale sockets
    }
  }

  console.log(`[Relay] Daemon registered: ${machineName} (${machineId}). Total: ${daemons.size}`);
  return replacedSocket;
}

/** Remove only records still owned by this exact socket and return their ids. */
export function unregisterDaemon(socket: WebSocket): string[] {
  const removed: string[] = [];
  // I-2:同一 socket 可能因换 machineId 重复注册而在 Map 里留有多条记录,
  // 必须全部清理,而非命中首条就 return。
  for (const [id, conn] of daemons) {
    if (conn.socket === socket) {
      daemons.delete(id);
      removed.push(id);
      console.log(
        `[Relay] Daemon disconnected: ${conn.machineName} (${id}). Total: ${daemons.size}`
      );
    }
  }
  return removed;
}

/** True only while this socket is the current registry owner for machineId. */
export function isDaemonOwner(socket: WebSocket, machineId: string): boolean {
  return daemons.get(machineId)?.socket === socket;
}

export function updateHeartbeat(machineId: string): void {
  const daemon = daemons.get(machineId);
  if (daemon) {
    daemon.lastHeartbeat = Date.now();
  }
}

export function getOnlineMachines(): Array<{
  machineId: string;
  machineName: string;
  online: boolean;
  lastSeen: number;
  publicKey?: string;
  keyId?: string;
}> {
  return Array.from(daemons.values()).map((d) => ({
    machineId: d.machineId,
    machineName: d.machineName,
    online: d.socket.readyState === WebSocket.OPEN,
    lastSeen: d.lastHeartbeat,
    ...(d.publicKey ? { publicKey: d.publicKey } : {}),
    ...(d.keyId ? { keyId: d.keyId } : {}),
  }));
}

// ── Message Routing ───────────────────────────────────

function sendJSON(socket: WebSocket, data: unknown): boolean {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(data));
    return true;
  }
  return false;
}

/**
 * Forward a relay-request from App to the target Daemon.
 * Returns true if the daemon was found and the message was sent.
 */
export function forwardToDaemon(
  machineId: string,
  requestId: string,
  token: string,
  payload: unknown
): boolean {
  const daemon = daemons.get(machineId);
  if (!daemon) {
    console.log(`[Relay] Daemon not found for machineId: ${machineId}`);
    return false;
  }

  return sendJSON(daemon.socket, {
    type: "forward-request",
    token,
    requestId,
    payload,
  });
}

/**
 * Send a raw object directly to a daemon by machineId (used for tunnel frames).
 * Returns whether an online daemon was found and the message was sent.
 */
export function sendRawToDaemon(machineId: string, obj: unknown): boolean {
  const daemon = daemons.get(machineId);
  if (!daemon) {
    console.log(`[Relay] Daemon not found for tunnel machineId: ${machineId}`);
    return false;
  }
  return sendJSON(daemon.socket, obj);
}

/**
 * Forward a daemon response/stream back to the App.
 * The appSocket must be passed by the caller (tracked per connection).
 */
export function forwardToApp(
  appSocket: WebSocket,
  type: "relay-response" | "relay-stream",
  requestId: string,
  payload: unknown
): boolean {
  return sendJSON(appSocket, { type, requestId, payload });
}

// ── Pairing Forwarding ────────────────────────────────

/**
 * Forward a pair-request from App to a Daemon.
 * If machineId is specified, targets that specific daemon.
 * If not, targets the only connected daemon (or fails if multiple).
 */
export function forwardPairRequest(
  appSocket: WebSocket,
  pairingCode: string,
  deviceId: string,
  deviceName: string,
  machineId?: string
): boolean {
  let targetDaemon: DaemonConnection | undefined;

  if (machineId) {
    targetDaemon = daemons.get(machineId);
  } else if (daemons.size === 1) {
    targetDaemon = daemons.values().next().value;
  } else if (daemons.size === 0) {
    relayLog("Pair request rejected: no daemon online");
    sendJSON(appSocket, {
      type: "pair-response",
      success: false,
      error: "No daemon is currently online.",
    });
    return false;
  } else {
    relayLog(`Pair request rejected: multiple daemons online (${daemons.size})`);
    sendJSON(appSocket, {
      type: "pair-response",
      success: false,
      error:
        "Multiple daemons are online. Please specify a machineId. Use list-machines to see available daemons.",
    });
    return false;
  }

  if (!targetDaemon) {
    relayLog(`Pair request rejected: daemon ${machineId} is not online`);
    sendJSON(appSocket, {
      type: "pair-response",
      success: false,
      error: `Daemon ${machineId} is not online.`,
    });
    return false;
  }

  // Forward to daemon
  const forwarded = sendJSON(targetDaemon.socket, {
    type: "pair-request",
    pairingCode,
    deviceId,
    deviceName,
  });
  if (!forwarded) {
    relayLog(`Pair request rejected: daemon ${targetDaemon.machineId} socket is not open`);
    sendJSON(appSocket, {
      type: "pair-response",
      success: false,
      error: `Daemon ${targetDaemon.machineId} is not online.`,
    });
    return false;
  }

  relayLog(`Pair request forwarded to daemon ${targetDaemon.machineId}`);

  // Track this pending pair request so we can route the response back
  const pending = pendingPairs.get(targetDaemon.machineId) || [];
  pending.push({ appSocket, requestedAt: Date.now() });
  pendingPairs.set(targetDaemon.machineId, pending);

  return true;
}

/**
 * Forward a pair-response from Daemon back to the waiting App.
 */
export function forwardPairResponse(machineId: string, response: unknown): boolean {
  const pending = pendingPairs.get(machineId);
  if (!pending || pending.length === 0) {
    console.log(`[Relay] No pending pair request for daemon ${machineId}`);
    return false;
  }

  // Pop the oldest pending request (FIFO)
  const request = pending.shift()!;
  if (pending.length === 0) {
    pendingPairs.delete(machineId);
  }

  const sent = sendJSON(request.appSocket, response);
  relayLog(`Pair response from daemon ${machineId} sentToApp=${sent}`);
  return sent;
}

// ── Heartbeat Cleanup ─────────────────────────────────

const HEARTBEAT_TIMEOUT_MS = 60 * 1000; // 60s without heartbeat = dead

export function cleanupStaleDaemons(): string[] {
  const now = Date.now();
  const removed: string[] = [];
  for (const [id, conn] of daemons) {
    if (now - conn.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
      console.log(`[Relay] Daemon ${conn.machineName} (${id}) timed out. Removing.`);
      // Relinquish ownership before close: a synchronous close callback must not
      // release the same generation twice or race the timer's returned cleanup.
      daemons.delete(id);
      removed.push(id);
      try {
        conn.socket.close(1000, "Heartbeat timeout");
      } catch {
        // Ignore
      }
    }
  }

  // Cleanup stale pair requests (older than 5 minutes)
  const PAIR_TIMEOUT_MS = 5 * 60 * 1000;
  for (const [mid, pending] of pendingPairs) {
    const filtered = pending.filter((p) => now - p.requestedAt < PAIR_TIMEOUT_MS);
    if (filtered.length === 0) {
      pendingPairs.delete(mid);
    } else {
      pendingPairs.set(mid, filtered);
    }
  }
  return removed;
}
