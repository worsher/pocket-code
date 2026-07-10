import { useEffect, useRef, useState } from "react";
import type { Message, ToolCall } from "@pocket-code/client-core";
import { computeLineDiff } from "../lineDiff";
import { useWebAgent } from "../useWebAgent";
import type { WebAgentStore } from "../webAgentStore";

export default function ChatPage({ store }: { store: WebAgentStore }) {
  const state = useWebAgent(store);
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [state.messages]);

  function send() {
    const content = input.trim();
    if (!content || !state.connected) return;
    store.sendMessage(content);
    setInput("");
  }

  return (
    <div className="chat-page">
      <div className="messages">
        {state.messages.map((m) => (
          <MessageRow key={m.id} message={m} />
        ))}
        {state.phase !== "idle" && <div className="phase-indicator">{PHASE_LABEL[state.phase]}</div>}
        <div ref={bottomRef} />
      </div>
      <div className="composer">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
          }}
          placeholder={state.connected ? "输入消息,Enter 发送" : "未连接"}
        />
        <button onClick={send} disabled={!state.connected || !input.trim()}>发送</button>
      </div>
    </div>
  );
}

const PHASE_LABEL: Record<string, string> = {
  connecting: "连接中…", thinking: "正在思考…", generating: "正在回复…",
  "tool-calling": "准备执行", "tool-running": "执行中",
};

function MessageRow({ message }: { message: Message }) {
  return (
    <div className={`msg ${message.role}`}>
      {message.thinking && <details className="thinking"><summary>思考过程</summary><pre>{message.thinking}</pre></details>}
      {message.toolCalls?.map((tc, i) => <ToolCard key={tc.callId ?? i} tool={tc} />)}
      {message.content && <div className="bubble">{message.content}</div>}
    </div>
  );
}

function ToolCard({ tool }: { tool: ToolCall }) {
  const result = tool.result as
    | { success?: boolean; newContent?: string; oldContent?: string; path?: string; isNew?: boolean }
    | undefined;
  const isDiff = tool.toolName === "writeFile" && result?.success && typeof result.newContent === "string";
  return (
    <div className="tool-card">
      <div className="tool-head">
        <span className="tool-name">⚙ {tool.toolName}</span>
        <span className="tool-status">{tool.result === undefined ? "running…" : "done"}</span>
      </div>
      {isDiff ? (
        <DiffBlock path={result!.path || String(tool.args.path ?? "unknown")}
                   oldContent={result!.oldContent || ""} newContent={result!.newContent!} />
      ) : (
        tool.result !== undefined && (
          <pre className="tool-result">{typeof tool.result === "string"
            ? tool.result.slice(0, 500)
            : JSON.stringify(tool.result, null, 2).slice(0, 500)}</pre>
        )
      )}
    </div>
  );
}

function DiffBlock({ path, oldContent, newContent }: { path: string; oldContent: string; newContent: string }) {
  const lines = computeLineDiff(oldContent, newContent);
  return (
    <div className="diff-block">
      <div className="diff-path">{path}</div>
      <pre>
        {lines.map((l, i) => (
          <div key={i} className={`diff-line ${l.kind}`}>
            {l.kind === "add" ? "+ " : l.kind === "del" ? "- " : "  "}{l.text}
          </div>
        ))}
      </pre>
    </div>
  );
}
