// ── Offline Message Queue ─────────────────────────────────
// Queues messages when the device is offline and replays them
// when connectivity is restored.

import AsyncStorage from "@react-native-async-storage/async-storage";

const QUEUE_KEY = "pocket-code:offline-queue";

export interface QueuedMessage {
  id: string;
  sessionId: string;
  content: string;
  timestamp: number;
  retries: number;
}

/**
 * Add a message to the offline queue.
 */
export async function enqueueMessage(
  sessionId: string,
  content: string
): Promise<QueuedMessage> {
  const msg: QueuedMessage = {
    id: `offline_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    sessionId,
    content,
    timestamp: Date.now(),
    retries: 0,
  };

  const queue = await getQueue();
  queue.push(msg);
  await saveQueue(queue);
  return msg;
}

/**
 * Get all queued messages.
 */
export async function getQueue(): Promise<QueuedMessage[]> {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as QueuedMessage[];
  } catch {
    return [];
  }
}

/**
 * Remove a message from the queue (after successful send).
 */
export async function dequeueMessage(id: string): Promise<void> {
  const queue = await getQueue();
  const filtered = queue.filter((m) => m.id !== id);
  await saveQueue(filtered);
}

/**
 * Mark a message as retried (increment retry count).
 */
export async function markRetried(id: string): Promise<void> {
  const queue = await getQueue();
  const updated = queue.map((m) =>
    m.id === id ? { ...m, retries: m.retries + 1 } : m
  );
  await saveQueue(updated);
}

/**
 * Remove messages that have exceeded max retries.
 */
export async function pruneFailedMessages(maxRetries: number = 3): Promise<QueuedMessage[]> {
  const queue = await getQueue();
  const failed = queue.filter((m) => m.retries >= maxRetries);
  const remaining = queue.filter((m) => m.retries < maxRetries);
  await saveQueue(remaining);
  return failed;
}

/**
 * Clear the entire queue.
 */
export async function clearQueue(): Promise<void> {
  await AsyncStorage.removeItem(QUEUE_KEY);
}

/**
 * Get queue size.
 */
export async function getQueueSize(): Promise<number> {
  const queue = await getQueue();
  return queue.length;
}

async function saveQueue(queue: QueuedMessage[]): Promise<void> {
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}
