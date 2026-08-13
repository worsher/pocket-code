import type { Message } from "@pocket-code/client-core";
import type { QueuedMessage } from "../services/offlineQueue";

function belongsToTurn(message: Message, turnId: string): boolean {
  return message.turnId === turnId;
}

/**
 * Materialize one durable queue record as one canonical UI turn.
 *
 * Replays may revisit a turn after a disconnect, so this operation is
 * intentionally idempotent: it preserves any partial assistant output, removes
 * duplicate bubbles for the same turn, and keeps the queue payload authoritative
 * for the user bubble.
 */
export function prepareQueuedTurnMessages(messages: Message[], queued: QueuedMessage): Message[] {
  const turnId = queued.id;
  const existingUser = messages.find(
    (message) => message.role === "user" && belongsToTurn(message, turnId)
  );
  const existingAssistant = messages.find(
    (message) => message.role === "assistant" && belongsToTurn(message, turnId)
  );
  const firstTurnIndex = messages.findIndex((message) => belongsToTurn(message, turnId));
  const timestamp = Date.now();

  const user: Message = existingUser
    ? {
        ...existingUser,
        content: queued.content,
        images: queued.images,
        pending: false,
      }
    : {
        id: `msg_user_${turnId}`,
        turnId,
        role: "user",
        content: queued.content,
        images: queued.images,
        timestamp,
        pending: false,
      };
  const assistant: Message = existingAssistant
    ? queued.retries > 0
      ? {
          ...existingAssistant,
          content: "",
          thinking: undefined,
          toolCalls: [],
          modelUsed: undefined,
          pending: false,
        }
      : { ...existingAssistant, pending: false }
    : {
        id: `msg_assistant_${turnId}`,
        turnId,
        role: "assistant",
        content: "",
        toolCalls: [],
        timestamp,
      };

  const withoutTurn = messages.filter((message) => !belongsToTurn(message, turnId));
  const insertionIndex =
    firstTurnIndex === -1
      ? withoutTurn.length
      : messages.slice(0, firstTurnIndex).filter((message) => !belongsToTurn(message, turnId))
          .length;

  return [
    ...withoutTurn.slice(0, insertionIndex),
    user,
    assistant,
    ...withoutTurn.slice(insertionIndex),
  ];
}
