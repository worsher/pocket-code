import AsyncStorage from "@react-native-async-storage/async-storage";

// ── Types ──────────────────────────────────────────────

import type { StoredMessage } from "@pocket-code/client-core";
export type { StoredMessage, StoredImageAttachment } from "@pocket-code/client-core";

export interface SessionInfo {
  id: string;
  projectId: string; // Project this session belongs to (empty = legacy)
  title: string; // First user message or "New Chat"
  lastUpdated: number;
  messageCount: number;
}

// ── Keys ───────────────────────────────────────────────

const SESSIONS_KEY = "pocket-code:sessions";
const chatKey = (sessionId: string) => `pocket-code:chat:${sessionId}`;
let historyWriteTail: Promise<void> = Promise.resolve();

function enqueueHistoryWrite(task: () => Promise<void>): Promise<void> {
  const run = historyWriteTail.catch(() => undefined).then(task);
  historyWriteTail = run.catch(() => undefined);
  return run;
}

async function readSessionsStrict(): Promise<SessionInfo[]> {
  const raw = await AsyncStorage.getItem(SESSIONS_KEY);
  const parsed: unknown = raw ? JSON.parse(raw) : [];
  if (!Array.isArray(parsed)) throw new Error("Stored session index is not an array");

  const sessions = parsed as SessionInfo[];
  for (const session of sessions) {
    if (!session || typeof session !== "object") {
      throw new Error("Stored session index contains an invalid entry");
    }
    if (session.projectId === undefined) session.projectId = "";
  }
  return sessions.sort((a, b) => b.lastUpdated - a.lastUpdated);
}

/** Read-only callers keep the legacy empty-list fallback for a damaged index. */
async function readSessions(): Promise<SessionInfo[]> {
  try {
    return await readSessionsStrict();
  } catch {
    return [];
  }
}

// ── API ────────────────────────────────────────────────

export async function saveChatHistory(
  sessionId: string,
  messages: StoredMessage[],
  projectId: string = ""
): Promise<void> {
  return enqueueHistoryWrite(async () => {
    // Read the index before touching either durable key. A transient read or
    // parse failure must not turn an existing index into a one-session index.
    const sessions = await readSessionsStrict();
    await AsyncStorage.setItem(chatKey(sessionId), JSON.stringify(messages));

    // Serialize chat + index as one logical write so an older save can never
    // finish after and overwrite a newer turn snapshot.
    const firstUserMsg = messages.find((m) => m.role === "user");
    const title = firstUserMsg?.content.slice(0, 50) || "New Chat";
    const existing = sessions.find((s) => s.id === sessionId);
    if (existing) {
      existing.title = title;
      existing.lastUpdated = Date.now();
      existing.messageCount = messages.length;
      existing.projectId = projectId;
    } else {
      sessions.push({
        id: sessionId,
        projectId,
        title,
        lastUpdated: Date.now(),
        messageCount: messages.length,
      });
    }
    await AsyncStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
  });
}

export async function loadChatHistory(sessionId: string): Promise<StoredMessage[]> {
  await historyWriteTail;
  try {
    const raw = await AsyncStorage.getItem(chatKey(sessionId));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/**
 * Recovery paths must distinguish an empty history from a storage failure. If a
 * cold-start queue replay continued with an unreadable archive, its eventual save
 * would overwrite every earlier turn with only the recovered pending pair.
 */
export async function loadChatHistoryStrict(sessionId: string): Promise<StoredMessage[]> {
  await historyWriteTail;
  const raw = await AsyncStorage.getItem(chatKey(sessionId));
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("Stored chat history is not an array");
  return parsed as StoredMessage[];
}

export async function listSessions(): Promise<SessionInfo[]> {
  await historyWriteTail;
  return readSessions();
}

/** List sessions filtered by projectId */
export async function listSessionsByProject(projectId: string): Promise<SessionInfo[]> {
  const all = await listSessions();
  return all.filter((s) => s.projectId === projectId);
}

export async function deleteSession(sessionId: string): Promise<void> {
  return enqueueHistoryWrite(async () => {
    const sessions = await readSessionsStrict();
    await AsyncStorage.removeItem(chatKey(sessionId));
    const filtered = sessions.filter((s) => s.id !== sessionId);
    await AsyncStorage.setItem(SESSIONS_KEY, JSON.stringify(filtered));
  });
}

export async function clearAllHistory(): Promise<void> {
  return enqueueHistoryWrite(async () => {
    const sessions = await readSessionsStrict();
    const keys = sessions.map((s) => chatKey(s.id));
    keys.push(SESSIONS_KEY);
    await AsyncStorage.multiRemove(keys);
  });
}

/** Idempotently moves locally archived sessions when a legacy project gets a UUID. */
export async function reassignSessionsProjectId(
  previousProjectId: string,
  replacementProjectId: string
): Promise<number> {
  let changed = 0;
  await enqueueHistoryWrite(async () => {
    const sessions = await readSessionsStrict();
    for (const session of sessions) {
      if (session.projectId !== previousProjectId) continue;
      session.projectId = replacementProjectId;
      changed++;
    }
    if (changed > 0) {
      await AsyncStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
    }
  });
  return changed;
}

// ── Search ────────────────────────────────────────────

export interface SearchResult {
  sessionId: string;
  sessionTitle: string;
  messageId: string;
  role: "user" | "assistant";
  snippet: string;
  timestamp: number;
}

/**
 * Search across all sessions for messages matching the query.
 * Returns up to `maxResults` matches sorted by timestamp (newest first).
 */
export async function searchSessions(
  query: string,
  maxResults: number = 50
): Promise<SearchResult[]> {
  if (!query.trim()) return [];

  const sessions = await listSessions();
  const lowerQuery = query.toLowerCase();
  const results: SearchResult[] = [];

  for (const session of sessions) {
    if (results.length >= maxResults) break;

    const messages = await loadChatHistory(session.id);
    for (const msg of messages) {
      if (results.length >= maxResults) break;

      const lowerContent = msg.content.toLowerCase();
      const matchIndex = lowerContent.indexOf(lowerQuery);
      if (matchIndex === -1) continue;

      // Build snippet: 40 chars before and after the match
      const start = Math.max(0, matchIndex - 40);
      const end = Math.min(msg.content.length, matchIndex + query.length + 40);
      let snippet = msg.content.slice(start, end);
      if (start > 0) snippet = "..." + snippet;
      if (end < msg.content.length) snippet += "...";

      results.push({
        sessionId: session.id,
        sessionTitle: session.title,
        messageId: msg.id,
        role: msg.role,
        snippet,
        timestamp: msg.timestamp,
      });
    }
  }

  return results.sort((a, b) => b.timestamp - a.timestamp);
}
