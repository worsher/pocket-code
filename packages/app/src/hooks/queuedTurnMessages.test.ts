import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@pocket-code/client-core";
import { createWorkspaceScope } from "@pocket-code/workspace-core";
import type { QueuedMessage } from "../services/offlineQueue";
import { prepareQueuedTurnMessages } from "./queuedTurnMessages";

const scope = createWorkspaceScope({
  projectId: "018f00d2-8931-7bc0-aad1-1ec83b13f982",
  replicaId: "74f1d64f-bf59-46a9-aa0b-7dcf42b95cab",
  sessionId: "session-1",
  workspaceGeneration: 3,
});

function queued(overrides: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    id: "turn-queued",
    scope,
    content: "queued question",
    timestamp: 1,
    retries: 0,
    provisional: false,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("prepareQueuedTurnMessages", () => {
  it("appends a deterministic user/assistant pair for a new queued turn", () => {
    vi.spyOn(Date, "now").mockReturnValue(42);
    const existing: Message = {
      id: "a-old",
      role: "assistant",
      content: "old answer",
      timestamp: 1,
    };
    const images = [{ uri: "file://one.png", base64: "abc", mimeType: "image/png" as const }];

    expect(prepareQueuedTurnMessages([existing], queued({ images }))).toEqual([
      existing,
      {
        id: "msg_user_turn-queued",
        turnId: "turn-queued",
        role: "user",
        content: "queued question",
        images,
        timestamp: 42,
        pending: false,
      },
      {
        id: "msg_assistant_turn-queued",
        turnId: "turn-queued",
        role: "assistant",
        content: "",
        toolCalls: [],
        timestamp: 42,
      },
    ]);
  });

  it("upserts only the matching pair and preserves partial assistant output", () => {
    const otherUser: Message = {
      id: "u-other",
      turnId: "turn-other",
      role: "user",
      content: "other question",
      timestamp: 1,
    };
    const pendingUser: Message = {
      id: "u-queued",
      turnId: "turn-queued",
      role: "user",
      content: "stale question",
      timestamp: 2,
      pending: true,
    };
    const pendingAssistant: Message = {
      id: "a-queued",
      turnId: "turn-queued",
      role: "assistant",
      content: "partial",
      timestamp: 3,
      pending: true,
    };
    const otherAssistant: Message = {
      id: "a-other",
      turnId: "turn-other",
      role: "assistant",
      content: "other answer",
      timestamp: 4,
    };

    const result = prepareQueuedTurnMessages(
      [otherUser, pendingUser, pendingAssistant, otherAssistant],
      queued({ content: "authoritative question" })
    );

    expect(result).toEqual([
      otherUser,
      {
        ...pendingUser,
        content: "authoritative question",
        images: undefined,
        pending: false,
      },
      { ...pendingAssistant, pending: false },
      otherAssistant,
    ]);
  });

  it("normalizes orphaned or duplicate bubbles to exactly one idempotent pair", () => {
    const orphanAssistant: Message = {
      id: "a-first",
      turnId: "turn-queued",
      role: "assistant",
      content: "partial",
      timestamp: 2,
      pending: true,
    };
    const duplicateAssistant: Message = {
      ...orphanAssistant,
      id: "a-duplicate",
      content: "must be removed",
    };
    const unrelated: Message = {
      id: "u-other",
      turnId: "turn-other",
      role: "user",
      content: "other",
      timestamp: 3,
    };

    const first = prepareQueuedTurnMessages(
      [orphanAssistant, duplicateAssistant, unrelated],
      queued()
    );
    const second = prepareQueuedTurnMessages(first, queued());

    expect(first.filter((message) => message.turnId === "turn-queued")).toHaveLength(2);
    expect(first.slice(0, 2)).toMatchObject([
      { role: "user", content: "queued question", pending: false },
      { id: "a-first", role: "assistant", content: "partial", pending: false },
    ]);
    expect(first[2]).toBe(unrelated);
    expect(second).toEqual(first);
  });

  it("clears a failed partial assistant before an explicit retry", () => {
    const messages: Message[] = [
      {
        id: "u",
        turnId: "turn-queued",
        role: "user",
        content: "queued question",
        timestamp: 1,
      },
      {
        id: "a",
        turnId: "turn-queued",
        role: "assistant",
        content: "partial\n\nError: transport failed",
        thinking: "old",
        toolCalls: [{ callId: "c", toolName: "readFile", args: {} }],
        modelUsed: "old-model",
        timestamp: 2,
      },
    ];

    const result = prepareQueuedTurnMessages(messages, queued({ retries: 1 }));
    expect(result[1]).toMatchObject({
      content: "",
      thinking: undefined,
      toolCalls: [],
      modelUsed: undefined,
      pending: false,
    });
  });
});
