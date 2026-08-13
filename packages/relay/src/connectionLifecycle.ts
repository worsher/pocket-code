import { WebSocket } from "ws";
import { unregisterDaemon } from "./relay.js";
import type { RequestTracker, StaleRequest } from "./requestTracker.js";
import type { TunnelHub } from "./tunnelHub.js";
import type { WsTunnelHub } from "./wsTunnelHub.js";

interface ConnectionState {
  role: "unknown" | "daemon" | "app";
  machineId: string | null;
}

export interface ConnectionLifecycleDeps {
  requests: RequestTracker<WebSocket>;
  tunnelHub: TunnelHub;
  wsTunnelHub: WsTunnelHub;
}

function sendJson(ws: WebSocket, value: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(value));
  } catch {
    // The App socket owns its reconnect path. Cleanup must still complete.
  }
}

function sendCorrelatedError(
  ws: WebSocket,
  requestId: string,
  error: string
): void {
  sendJson(ws, {
    type: "relay-response",
    requestId,
    payload: { type: "error", error },
  });
}

/** Release resources that were routed through one daemon generation. */
export function releaseDaemonResources(
  machineId: string,
  deps: ConnectionLifecycleDeps,
  error = `Daemon ${machineId} is not online.`
): void {
  deps.tunnelHub.abortByMachine(machineId);
  deps.wsTunnelHub.abortByMachine(machineId);
  for (const pending of deps.requests.drainByMachine(machineId)) {
    sendCorrelatedError(pending.ws, pending.requestId, error);
  }
}

/**
 * A close event only owns cleanup if unregisterDaemon confirms this exact socket
 * was still the current daemon owner. A replaced socket therefore cannot drain
 * requests that were subsequently sent to its replacement.
 */
export function handleRelayConnectionClosed(
  ws: WebSocket,
  state: ConnectionState,
  deps: ConnectionLifecycleDeps
): void {
  if (state.role === "daemon") {
    for (const machineId of unregisterDaemon(ws)) {
      releaseDaemonResources(machineId, deps);
    }
  } else if (state.role === "app") {
    deps.requests.deleteBySocket(ws);
  }
}

/**
 * Notify an open App about TTL expiry before deleting the matching tracker
 * version. Closed App sockets cannot receive a notification and are just pruned.
 */
export function expireStaleRequests(
  requests: RequestTracker<WebSocket>,
  now: number = Date.now()
): StaleRequest<WebSocket>[] {
  const stale = requests.findStale(now);
  for (const entry of stale) {
    if (entry.reason === "timeout") {
      sendCorrelatedError(
        entry.ws,
        entry.requestId,
        "Relay request timed out waiting for daemon response."
      );
    }
    requests.deleteIfMatch(entry);
  }
  return stale;
}
