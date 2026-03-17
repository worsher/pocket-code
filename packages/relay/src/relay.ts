// ── Relay Core ────────────────────────────────────────────
// Manages daemon connections, routes messages between App and Daemon,
// and forwards pairing requests/responses.

import { WebSocket } from "ws";

// ── Types ─────────────────────────────────────────────

interface DaemonConnection {
  socket: WebSocket;
  machineId: string;
  machineName: string;
  lastHeartbeat: number;
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
  machineName: string
): void {
  // If a daemon with the same machineId is already connected, close the old one
  const existing = daemons.get(machineId);
  if (existing && existing.socket !== socket) {
    console.log(`[Relay] Replacing existing daemon connection for ${machineId}`);
    try {
      existing.socket.close(1000, "Replaced by new connection");
    } catch {
      // Ignore close errors on stale sockets
    }
  }

  daemons.set(machineId, {
    socket,
    machineId,
    machineName,
    lastHeartbeat: Date.now(),
  });

  console.log(
    `[Relay] Daemon registered: ${machineName} (${machineId}). Total: ${daemons.size}`
  );
}

export function unregisterDaemon(socket: WebSocket): void {
  for (const [id, conn] of daemons) {
    if (conn.socket === socket) {
      daemons.delete(id);
      console.log(`[Relay] Daemon disconnected: ${conn.machineName} (${id}). Total: ${daemons.size}`);
      return;
    }
  }
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
}> {
  return Array.from(daemons.values()).map((d) => ({
    machineId: d.machineId,
    machineName: d.machineName,
    online: d.socket.readyState === WebSocket.OPEN,
    lastSeen: d.lastHeartbeat,
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
    sendJSON(appSocket, {
      type: "pair-response",
      success: false,
      error: "No daemon is currently online.",
    });
    return false;
  } else {
    sendJSON(appSocket, {
      type: "pair-response",
      success: false,
      error:
        "Multiple daemons are online. Please specify a machineId. Use list-machines to see available daemons.",
    });
    return false;
  }

  if (!targetDaemon) {
    sendJSON(appSocket, {
      type: "pair-response",
      success: false,
      error: `Daemon ${machineId} is not online.`,
    });
    return false;
  }

  // Track this pending pair request so we can route the response back
  const pending = pendingPairs.get(targetDaemon.machineId) || [];
  pending.push({ appSocket, requestedAt: Date.now() });
  pendingPairs.set(targetDaemon.machineId, pending);

  // Forward to daemon
  return sendJSON(targetDaemon.socket, {
    type: "pair-request",
    pairingCode,
    deviceId,
    deviceName,
  });
}

/**
 * Forward a pair-response from Daemon back to the waiting App.
 */
export function forwardPairResponse(
  machineId: string,
  response: unknown
): boolean {
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

  return sendJSON(request.appSocket, response);
}

// ── Heartbeat Cleanup ─────────────────────────────────

const HEARTBEAT_TIMEOUT_MS = 60 * 1000; // 60s without heartbeat = dead

export function cleanupStaleDaemons(): void {
  const now = Date.now();
  for (const [id, conn] of daemons) {
    if (now - conn.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
      console.log(
        `[Relay] Daemon ${conn.machineName} (${id}) timed out. Removing.`
      );
      try {
        conn.socket.close(1000, "Heartbeat timeout");
      } catch {
        // Ignore
      }
      daemons.delete(id);
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
}
