// ── 会话与 UI 状态类型(从 App 收编,client-core 为正典) ──────────

/** 流式指示器阶段(原 app/components/StreamingIndicator) */
export type StreamingPhase =
  | "connecting"
  | "thinking"
  | "generating"
  | "tool-calling"
  | "tool-running"
  | "idle";

/** 存档消息(原 app/store/chatHistory) */
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
