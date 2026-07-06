import { describe, it, expect } from "vitest";
import { applyAgentEvent, phaseFor, truncateCoreHistory, storedToCoreMessages, type Message } from "./chatReducer";
import type { CoreMessage } from "@pocket-code/agent-core";
import type { StoredMessage } from "../store/chatHistory";

const base = (over: Partial<Message> = {}): Message[] => [
  { id: "1", role: "user", content: "hi", timestamp: 1 },
  { id: "2", role: "assistant", content: "", toolCalls: [], timestamp: 2, ...over },
];

describe("applyAgentEvent", () => {
  it("appends text-delta to last assistant content", () => {
    const out = applyAgentEvent(base(), { type: "text-delta", text: "he" });
    const out2 = applyAgentEvent(out, { type: "text-delta", text: "llo" });
    expect(out2[1].content).toBe("hello");
    expect(out2[0]).toBe(out[0]); // 未动的消息保持引用
  });

  it("appends reasoning-delta to thinking", () => {
    const out = applyAgentEvent(base(), { type: "reasoning-delta", text: "mm" });
    expect(out[1].thinking).toBe("mm");
  });

  it("records tool-call and pairs tool-result by callId (并发同名工具不错配)", () => {
    let msgs = base();
    msgs = applyAgentEvent(msgs, { type: "tool-call", callId: "c1", name: "readFile", args: { path: "a" } });
    msgs = applyAgentEvent(msgs, { type: "tool-call", callId: "c2", name: "readFile", args: { path: "b" } });
    msgs = applyAgentEvent(msgs, { type: "tool-result", callId: "c2", result: "B" });
    const tcs = msgs[1].toolCalls!;
    expect(tcs[0].result).toBeUndefined();
    expect(tcs[1].result).toBe("B");
  });

  it("falls back to first unresolved call when callId unmatched", () => {
    let msgs = base();
    msgs = applyAgentEvent(msgs, { type: "tool-call", callId: "c1", name: "x", args: {} });
    msgs = applyAgentEvent(msgs, { type: "tool-result", callId: "zz", result: 1 });
    expect(msgs[1].toolCalls![0].result).toBe(1);
  });

  it("sets modelUsed on model-selected and appends error text", () => {
    let msgs = base();
    msgs = applyAgentEvent(msgs, { type: "model-selected", modelKey: "deepseek-v3", reason: "simple" });
    expect(msgs[1].modelUsed).toBe("deepseek-v3");
    msgs = applyAgentEvent(msgs, { type: "error", message: "boom" });
    expect(msgs[1].content).toContain("Error: boom");
  });

  it("returns same reference for ignored events and when last is not assistant", () => {
    const msgs = base();
    expect(applyAgentEvent(msgs, { type: "done" })).toBe(msgs);
    expect(applyAgentEvent(msgs, { type: "usage", inputTokens: 1, outputTokens: 2 })).toBe(msgs);
    expect(applyAgentEvent(msgs, { type: "file-changed", path: "a", changeType: "modified" })).toBe(msgs);
    const userOnly: Message[] = [{ id: "1", role: "user", content: "x", timestamp: 1 }];
    expect(applyAgentEvent(userOnly, { type: "text-delta", text: "y" })).toBe(userOnly);
  });

  it("returns same reference when tool-result finds no unresolved call", () => {
    let msgs = applyAgentEvent(
      [
        { id: "1", role: "user", content: "hi", timestamp: 1 },
        { id: "2", role: "assistant", content: "", toolCalls: [], timestamp: 2 },
      ],
      { type: "tool-call", callId: "c1", name: "x", args: {} }
    );
    msgs = applyAgentEvent(msgs, { type: "tool-result", callId: "c1", result: 1 });
    const after = applyAgentEvent(msgs, { type: "tool-result", callId: "c9", result: 2 });
    expect(after).toBe(msgs); // 全部已完成,落空 → 原引用
  });
});

describe("truncateCoreHistory", () => {
  const history: CoreMessage[] = [
    { role: "user", content: "turn1" },
    { role: "assistant", content: "reply1" },
    { role: "user", content: "turn2" },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "readFile", args: {} }] },
    { role: "tool", toolCallId: "c1", toolName: "readFile", content: "{}" },
    { role: "assistant", content: "reply2" },
    { role: "user", content: "turn3" },
    { role: "assistant", content: "reply3" },
  ];

  it("keeps everything before the Nth+1 user message", () => {
    const out = truncateCoreHistory(history, 1);
    expect(out).toEqual([
      { role: "user", content: "turn1" },
      { role: "assistant", content: "reply1" },
    ]);
  });

  it("keeps 2 full turns (multi-step turn included) when keepUserTurns=2", () => {
    const out = truncateCoreHistory(history, 2);
    expect(out).toEqual(history.slice(0, 6));
  });

  it("returns empty array when keepUserTurns is 0", () => {
    expect(truncateCoreHistory(history, 0)).toEqual([]);
  });

  it("returns the full history (copy) when keepUserTurns >= total user turns", () => {
    const out = truncateCoreHistory(history, 3);
    expect(out).toEqual(history);
    expect(out).not.toBe(history);
  });

  it("returns empty array for empty history", () => {
    expect(truncateCoreHistory([], 5)).toEqual([]);
  });
});

describe("storedToCoreMessages (I1: loadSession core history reconstruction)", () => {
  it("converts a full user/assistant+toolCalls/images session and preserves shape", () => {
    const stored: StoredMessage[] = [
      {
        id: "1",
        role: "user",
        content: "look at this",
        images: [{ uri: "file://x.png", base64: "aGVsbG8=", mimeType: "image/png" }],
        timestamp: 1,
      },
      {
        id: "2",
        role: "assistant",
        content: "let me check",
        toolCalls: [
          { toolName: "readFile", args: { path: "a.ts" }, result: { success: true, content: "x" } },
          { toolName: "listFiles", args: { path: "." }, result: "plain-string-result" },
        ],
        timestamp: 2,
      },
      {
        id: "3",
        role: "user",
        content: "thanks, now write it",
        timestamp: 3,
      },
      {
        id: "4",
        role: "assistant",
        content: "done!",
        timestamp: 4,
      },
    ];

    const out = storedToCoreMessages(stored);

    expect(out).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "image", base64: "aGVsbG8=", mimeType: "image/png" },
        ],
      },
      {
        role: "assistant",
        content: "let me check",
        toolCalls: [
          { id: "stored-1-0", name: "readFile", args: { path: "a.ts" } },
          { id: "stored-1-1", name: "listFiles", args: { path: "." } },
        ],
      },
      {
        role: "tool",
        toolCallId: "stored-1-0",
        toolName: "readFile",
        content: JSON.stringify({ success: true, content: "x" }),
      },
      {
        role: "tool",
        toolCallId: "stored-1-1",
        toolName: "listFiles",
        content: "plain-string-result",
      },
      { role: "user", content: "thanks, now write it" },
      { role: "assistant", content: "done!" },
    ] satisfies CoreMessage[]);
  });

  it("plain user message without images becomes a string-content user message", () => {
    const stored: StoredMessage[] = [{ id: "1", role: "user", content: "hi", timestamp: 1 }];
    expect(storedToCoreMessages(stored)).toEqual([{ role: "user", content: "hi" }]);
  });

  it("assistant with empty toolCalls array is treated as plain text (no toolCalls field)", () => {
    const stored: StoredMessage[] = [
      { id: "1", role: "assistant", content: "ok", toolCalls: [], timestamp: 1 },
    ];
    expect(storedToCoreMessages(stored)).toEqual([{ role: "assistant", content: "ok" }]);
  });

  it("skips a tool message when the stored toolCall has no result yet", () => {
    const stored: StoredMessage[] = [
      {
        id: "1",
        role: "assistant",
        content: "",
        toolCalls: [{ toolName: "readFile", args: { path: "a.ts" } }],
        timestamp: 1,
      },
    ];
    const out = storedToCoreMessages(stored);
    expect(out).toEqual([
      { role: "assistant", content: "", toolCalls: [{ id: "stored-0-0", name: "readFile", args: { path: "a.ts" } }] },
    ]);
  });

  it("returns an empty array for an empty session", () => {
    expect(storedToCoreMessages([])).toEqual([]);
  });
});

describe("phaseFor", () => {
  it("maps events to streaming phases", () => {
    expect(phaseFor({ type: "reasoning-delta", text: "" })).toBe("thinking");
    expect(phaseFor({ type: "text-delta", text: "" })).toBe("generating");
    expect(phaseFor({ type: "tool-call", callId: "c", name: "n", args: {} })).toBe("tool-calling");
    expect(phaseFor({ type: "tool-result", callId: "c", result: 1 })).toBe("generating");
    expect(phaseFor({ type: "done" })).toBe("idle");
    expect(phaseFor({ type: "error", message: "e" })).toBe("idle");
    expect(phaseFor({ type: "usage", inputTokens: 0, outputTokens: 0 })).toBeNull();
  });
});
