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

const QUEUE_KEY = "pocket-code:offline-queue";
const QUARANTINE_KEY = "pocket-code:offline-queue:quarantine";

export interface QueuedMessage {
  id: string;
  scope: WorkspaceScope;
  content: string;
  timestamp: number;
  retries: number;
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
      content: candidate.content,
      timestamp: candidate.timestamp,
      retries: candidate.retries,
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
    JSON.stringify([...existing, ...values.map((value) => ({ value, quarantinedAt: Date.now() }))]),
  );
}

/** Add a fully scoped message to the offline queue. */
export async function enqueueMessage(
  scopeInput: WorkspaceScopeInput,
  content: string,
  options?: { provisional?: boolean },
): Promise<QueuedMessage> {
  const msg: QueuedMessage = {
    id: `offline_${randomUUID()}`,
    scope: createWorkspaceScope(scopeInput),
    content,
    timestamp: Date.now(),
    retries: 0,
    provisional: options?.provisional === true,
  };

  const queue = await getQueue();
  queue.push(msg);
  await saveQueue(queue);
  return msg;
}

/**
 * Bind first-connect offline messages to the remote replica returned by the
 * server. Only explicitly provisional records from the exact old scope move.
 */
export async function rebindProvisionalQueue(
  previousScope: WorkspaceScope,
  authoritativeScope: WorkspaceScope,
): Promise<number> {
  const queue = await getQueue();
  let rebound = 0;
  const updated = queue.map((message) => {
    if (!message.provisional || !isSameWorkspaceScope(previousScope, message.scope)) {
      return message;
    }
    rebound++;
    return { ...message, scope: authoritativeScope, provisional: false };
  });
  if (rebound > 0) await saveQueue(updated);
  return rebound;
}

/**
 * Get valid queue entries. Legacy/unscoped or corrupt entries are moved to a
 * quarantine key instead of being replayed into whichever project is active.
 */
export async function getQueue(): Promise<QueuedMessage[]> {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
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
  } catch {
    return [];
  }
}

export async function getQueueForScope(scope: WorkspaceScope): Promise<QueuedMessage[]> {
  return (await getQueue()).filter((message) => isSameWorkspaceScope(scope, message.scope));
}

/** Remove a message from the queue after successful send. */
export async function dequeueMessage(id: string): Promise<void> {
  const queue = await getQueue();
  const filtered = queue.filter((message) => message.id !== id);
  await saveQueue(filtered);
}

/** Mark a message as retried (increment retry count). */
export async function markRetried(id: string): Promise<void> {
  const queue = await getQueue();
  const updated = queue.map((message) =>
    message.id === id ? { ...message, retries: message.retries + 1 } : message,
  );
  await saveQueue(updated);
}

/** Remove messages that have exceeded max retries. */
export async function pruneFailedMessages(maxRetries: number = 3): Promise<QueuedMessage[]> {
  const queue = await getQueue();
  const failed = queue.filter((message) => message.retries >= maxRetries);
  const remaining = queue.filter((message) => message.retries < maxRetries);
  await saveQueue(remaining);
  return failed;
}

export async function clearQueue(): Promise<void> {
  await AsyncStorage.removeItem(QUEUE_KEY);
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
