import AsyncStorage from "@react-native-async-storage/async-storage";

// ── Types ──────────────────────────────────────────────

export interface StoredImageAttachment {
    uri: string;
    base64: string;
    mimeType: "image/jpeg" | "image/png";
}

export interface StoredMessage {
    id: string;
    role: "user" | "assistant";
    content: string;
    thinking?: string;
    toolCalls?: {
        toolName: string;
        args: Record<string, unknown>;
        result?: unknown;
    }[];
    images?: StoredImageAttachment[];
    timestamp: number;
    pending?: boolean;
    modelUsed?: string;
}

export interface SessionInfo {
    id: string;
    title: string; // First user message or "New Chat"
    lastUpdated: number;
    messageCount: number;
}

// ── Keys ───────────────────────────────────────────────

const SESSIONS_KEY = "pocket-code:sessions";
const chatKey = (sessionId: string) => `pocket-code:chat:${sessionId}`;

// ── API ────────────────────────────────────────────────

export async function saveChatHistory(
    sessionId: string,
    messages: StoredMessage[]
): Promise<void> {
    await AsyncStorage.setItem(chatKey(sessionId), JSON.stringify(messages));

    // Update session index
    const sessions = await listSessions();
    const firstUserMsg = messages.find((m) => m.role === "user");
    const title = firstUserMsg?.content.slice(0, 50) || "New Chat";
    const existing = sessions.find((s) => s.id === sessionId);
    if (existing) {
        existing.title = title;
        existing.lastUpdated = Date.now();
        existing.messageCount = messages.length;
    } else {
        sessions.push({
            id: sessionId,
            title,
            lastUpdated: Date.now(),
            messageCount: messages.length,
        });
    }
    await AsyncStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
}

export async function loadChatHistory(
    sessionId: string
): Promise<StoredMessage[]> {
    try {
        const raw = await AsyncStorage.getItem(chatKey(sessionId));
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

export async function listSessions(): Promise<SessionInfo[]> {
    try {
        const raw = await AsyncStorage.getItem(SESSIONS_KEY);
        const sessions: SessionInfo[] = raw ? JSON.parse(raw) : [];
        // Sort by last updated, newest first
        return sessions.sort((a, b) => b.lastUpdated - a.lastUpdated);
    } catch {
        return [];
    }
}

export async function deleteSession(sessionId: string): Promise<void> {
    await AsyncStorage.removeItem(chatKey(sessionId));
    const sessions = await listSessions();
    const filtered = sessions.filter((s) => s.id !== sessionId);
    await AsyncStorage.setItem(SESSIONS_KEY, JSON.stringify(filtered));
}

export async function clearAllHistory(): Promise<void> {
    const sessions = await listSessions();
    const keys = sessions.map((s) => chatKey(s.id));
    keys.push(SESSIONS_KEY);
    await AsyncStorage.multiRemove(keys);
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
            const end = Math.min(
                msg.content.length,
                matchIndex + query.length + 40
            );
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
