// ── Offline Message Queue ─────────────────────────────────
// Queues messages when the device is offline and replays them only into the
// exact project/replica/session/generation that created them.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { randomUUID } from "expo-crypto";
import {
  createWorkspaceScope,
  isSameWorkspaceScope,
  type WorkspaceScope,
  type WorkspaceScopeInput,
} from "@pocket-code/workspace-core";
import type { StoredImageAttachment } from "@pocket-code/client-core";

const QUEUE_KEY = "pocket-code:offline-queue";
const QUARANTINE_KEY = "pocket-code:offline-queue:quarantine";
let queueWriteTail: Promise<void> = Promise.resolve();

function enqueueQueueWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = queueWriteTail.catch(() => undefined).then(task);
  queueWriteTail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export interface QueuedMessage {
  id: string;
  scope: WorkspaceScope;
  /** Remote route that accepted this turn. Prevents replay into another authority. */
  connectionKey?: string;
  /** Server catalog identity for an already-authoritative replica. */
  authorityId?: string;
  content: string;
  images?: StoredImageAttachment[];
  model?: string;
  customPrompt?: string;
  rewindTo?: number;
  timestamp: number;
  retries: number;
  /** Kept for manual recovery, but excluded from automatic replay. */
  blockedReason?: string;
  /** Awaiting the first authoritative remote replica acknowledgement. */
  provisional: boolean;
}

function parseQueuedMessage(value: unknown): QueuedMessage | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const rawScope = candidate.scope;
  if (!rawScope || typeof rawScope !== "object") return null;
  const scopeValue = rawScope as Record<string, unknown>;

  try {
    const scope = createWorkspaceScope({
      projectId: String(scopeValue.projectId ?? ""),
      replicaId: String(scopeValue.replicaId ?? ""),
      sessionId: String(scopeValue.sessionId ?? ""),
      workspaceGeneration: Number(scopeValue.workspaceGeneration),
    });
    if (
      typeof candidate.id !== "string" ||
      typeof candidate.content !== "string" ||
      typeof candidate.timestamp !== "number" ||
      typeof candidate.retries !== "number"
    ) {
      return null;
    }
    return {
      id: candidate.id,
      scope,
      connectionKey:
        typeof candidate.connectionKey === "string" ? candidate.connectionKey : undefined,
      authorityId: typeof candidate.authorityId === "string" ? candidate.authorityId : undefined,
      content: candidate.content,
      images: Array.isArray(candidate.images)
        ? (candidate.images as StoredImageAttachment[])
        : undefined,
      model: typeof candidate.model === "string" ? candidate.model : undefined,
      customPrompt: typeof candidate.customPrompt === "string" ? candidate.customPrompt : undefined,
      rewindTo:
        typeof candidate.rewindTo === "number" && Number.isInteger(candidate.rewindTo)
          ? candidate.rewindTo
          : undefined,
      timestamp: candidate.timestamp,
      retries: candidate.retries,
      blockedReason:
        typeof candidate.blockedReason === "string" ? candidate.blockedReason : undefined,
      // Records written before this field existed were already authoritative.
      provisional: candidate.provisional === true,
    };
  } catch {
    return null;
  }
}

async function quarantine(values: unknown[]): Promise<void> {
  if (values.length === 0) return;
  let existing: unknown[] = [];
  try {
    const raw = await AsyncStorage.getItem(QUARANTINE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) existing = parsed;
  } catch {
    // A corrupt quarantine must not make unsafe queue records replayable.
  }
  await AsyncStorage.setItem(
    QUARANTINE_KEY,
    JSON.stringify([...existing, ...values.map((value) => ({ value, quarantinedAt: Date.now() }))])
  );
}

/** Add a fully scoped message to the offline queue. */
export async function enqueueMessage(
  scopeInput: WorkspaceScopeInput,
  content: string,
  options?: {
    /** Stable turn id when a live submission is durably queued before transport send. */
    id?: string;
    provisional?: boolean;
    connectionKey?: string;
    authorityId?: string;
    images?: StoredImageAttachment[];
    model?: string;
    customPrompt?: string;
    rewindTo?: number;
  }
): Promise<QueuedMessage> {
  const msg: QueuedMessage = {
    id: options?.id ?? `offline_${randomUUID()}`,
    scope: createWorkspaceScope(scopeInput),
    connectionKey: options?.connectionKey,
    authorityId: options?.authorityId,
    content,
    images: options?.images,
    model: options?.model,
    customPrompt: options?.customPrompt,
    rewindTo: options?.rewindTo,
    timestamp: Date.now(),
    retries: 0,
    provisional: options?.provisional === true,
  };

  return enqueueQueueWrite(async () => {
    const queue = await readQueue();
    const existingIndex = queue.findIndex((message) => message.id === msg.id);
    if (existingIndex === -1) queue.push(msg);
    else queue[existingIndex] = { ...queue[existingIndex], ...msg };
    await saveQueue(queue);
    return msg;
  });
}

/**
 * Bind first-connect offline messages to the remote replica returned by the
 * server. Only explicitly provisional records from the exact old scope move.
 */
export async function rebindProvisionalQueue(
  previousScope: WorkspaceScope,
  authoritativeScope: WorkspaceScope,
  route: { connectionKey: string; authorityId: string }
): Promise<number> {
  return enqueueQueueWrite(async () => {
    const queue = await readQueue();
    let rebound = 0;
    const updated = queue.map((message) => {
      if (
        !message.provisional ||
        !isSameWorkspaceScope(previousScope, message.scope) ||
        message.connectionKey !== route.connectionKey
      ) {
        return message;
      }
      rebound++;
      return {
        ...message,
        scope: authoritativeScope,
        connectionKey: route.connectionKey,
        authorityId: route.authorityId,
        provisional: false,
      };
    });
    if (rebound > 0) await saveQueue(updated);
    return rebound;
  });
}

/**
 * Get valid queue entries. Legacy/unscoped or corrupt entries are moved to a
 * quarantine key instead of being replayed into whichever project is active.
 */
export async function getQueue(): Promise<QueuedMessage[]> {
  await queueWriteTail;
  return readQueue();
}

async function readQueue(): Promise<QueuedMessage[]> {
  const raw = await AsyncStorage.getItem(QUEUE_KEY);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Malformed stored bytes are data corruption, not a transient read error.
    // Quarantine them explicitly; AsyncStorage I/O failures above must propagate
    // so no mutator can overwrite an unreadable-but-valid durable queue with [].
    await quarantine([raw]);
    await saveQueue([]);
    return [];
  }
  {
    if (!Array.isArray(parsed)) {
      await quarantine([parsed]);
      await saveQueue([]);
      return [];
    }

    const queue: QueuedMessage[] = [];
    const invalid: unknown[] = [];
    for (const value of parsed) {
      const message = parseQueuedMessage(value);
      if (message) queue.push(message);
      else invalid.push(value);
    }
    if (invalid.length > 0) {
      await quarantine(invalid);
      await saveQueue(queue);
    }
    return queue;
  }
}

/**
 * Earliest queue scope that can be proven to belong to the current remote route.
 *
 * New records carry connectionKey. Older authoritative records remain recoverable
 * only when their replica id/generation exactly matches the retained catalog row;
 * an unscoped provisional record is deliberately not replayed across authorities.
 */
export async function getResumeScopeForProject(args: {
  projectId: string;
  connectionKey: string;
  retainedReplica?: { id: string; generation: number; authorityId: string } | null;
}): Promise<WorkspaceScope | null> {
  const queued = (await getQueue())
    .filter((message) => {
      if (message.scope.projectId !== args.projectId) return false;
      if (message.connectionKey) {
        if (message.connectionKey !== args.connectionKey) return false;
        if (message.provisional) return true;
        const retained = args.retainedReplica;
        return Boolean(
          retained &&
          message.scope.replicaId === retained.id &&
          message.scope.workspaceGeneration === retained.generation &&
          (!message.authorityId || message.authorityId === retained.authorityId)
        );
      }

      // Backward compatibility for records created before route metadata existed.
      if (message.provisional) return false;
      const retained = args.retainedReplica;
      return Boolean(
        retained &&
        message.scope.replicaId === retained.id &&
        message.scope.workspaceGeneration === retained.generation
      );
    })
    .sort((left, right) => left.timestamp - right.timestamp);
  // An indeterminate earlier turn is an ordering barrier. Do not silently skip
  // it and restore a later session/turn from the same route.
  return queued[0]?.blockedReason ? null : (queued[0]?.scope ?? null);
}

export async function getQueueForScope(scope: WorkspaceScope): Promise<QueuedMessage[]> {
  return (await getQueue()).filter((message) => isSameWorkspaceScope(scope, message.scope));
}

/**
 * Return only authoritative turns proven to belong to the current connection.
 *
 * Scope equality alone is insufficient: two authorities may acknowledge the
 * same provisional client scope. Legacy records without route metadata remain
 * durable but are never replayed automatically.
 */
export async function getQueueForReplay(
  scope: WorkspaceScope,
  route: { connectionKey: string; authorityId: string }
): Promise<QueuedMessage[]> {
  const matching = (await getQueue()).filter(
    (message) =>
      isSameWorkspaceScope(scope, message.scope) &&
      message.connectionKey === route.connectionKey &&
      message.authorityId === route.authorityId
  );
  const barrier = matching.findIndex((message) => Boolean(message.blockedReason));
  return matching
    .slice(0, barrier === -1 ? matching.length : barrier)
    .filter((message) => !message.provisional);
}

/** Remove a message from the queue after successful send. */
export async function dequeueMessage(id: string): Promise<void> {
  await enqueueQueueWrite(async () => {
    const queue = await readQueue();
    const filtered = queue.filter((message) => message.id !== id);
    await saveQueue(filtered);
  });
}

/** Mark a message as retried (increment retry count). */
export async function markRetried(id: string): Promise<void> {
  await enqueueQueueWrite(async () => {
    const queue = await readQueue();
    const updated = queue.map((message) =>
      message.id === id ? { ...message, retries: message.retries + 1 } : message
    );
    await saveQueue(updated);
  });
}

/**
 * Preserve an indeterminate legacy turn without ever replaying it automatically.
 * The record remains available for a future explicit recovery UI or export.
 */
export async function markUncertain(id: string, reason: string): Promise<void> {
  await enqueueQueueWrite(async () => {
    const queue = await readQueue();
    const updated = queue.map((message) =>
      message.id === id
        ? { ...message, retries: message.retries + 1, blockedReason: reason }
        : message
    );
    await saveQueue(updated);
  });
}

/** Remove messages that have exceeded max retries. */
export async function pruneFailedMessages(maxRetries: number = 3): Promise<QueuedMessage[]> {
  return enqueueQueueWrite(async () => {
    const queue = await readQueue();
    const failed = queue.filter((message) => message.retries >= maxRetries);
    const remaining = queue.filter((message) => message.retries < maxRetries);
    await saveQueue(remaining);
    return failed;
  });
}

export async function clearQueue(): Promise<void> {
  await enqueueQueueWrite(() => AsyncStorage.removeItem(QUEUE_KEY));
}

export async function getQueueSize(): Promise<number> {
  return (await getQueue()).length;
}

export async function getQuarantinedMessages(): Promise<unknown[]> {
  try {
    const raw = await AsyncStorage.getItem(QUARANTINE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveQueue(queue: QueuedMessage[]): Promise<void> {
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}
