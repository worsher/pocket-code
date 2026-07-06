/**
 * Legacy AI SDK message history converter.
 * Converts old format messages to CoreMessage format with best-effort approach.
 */

import type { CoreMessage, ContentPart } from "./types.js";

export function fromLegacyAiSdkMessages(raw: unknown[]): CoreMessage[] {
  const result: CoreMessage[] = [];
  let toolPartsWarningLogged = false;

  for (const item of raw) {
    // Skip non-objects
    if (typeof item !== "object" || item === null) {
      continue;
    }

    const obj = item as Record<string, unknown>;

    // Validate role and content existence
    if (typeof obj.role !== "string" || !["user", "assistant", "system"].includes(obj.role)) {
      continue;
    }

    const role = obj.role as "user" | "assistant" | "system";
    const content = obj.content;

    // Case 1: Plain string content
    if (typeof content === "string") {
      result.push({ role, content });
      continue;
    }

    // Case 2: Array of parts (multi-modal or tool calls)
    if (Array.isArray(content)) {
      const textParts: string[] = [];
      const imageParts: ContentPart[] = [];
      let hasToolParts = false;

      for (const part of content) {
        if (typeof part !== "object" || part === null) {
          continue;
        }

        const p = part as Record<string, unknown>;
        const partType = p.type;

        if (partType === "text" && typeof p.text === "string") {
          textParts.push(p.text);
        } else if (partType === "image" && typeof p.image === "string" && typeof p.mimeType === "string") {
          // Convert from legacy image format to ContentPart
          imageParts.push({
            type: "image",
            base64: p.image,
            mimeType: p.mimeType,
          });
        } else if (partType === "tool-call" || partType === "tool-result") {
          hasToolParts = true;
        }
      }

      // Log warning once if tool parts were dropped
      if (hasToolParts && !toolPartsWarningLogged) {
        console.warn("[fromLegacyAiSdkMessages] Dropped tool-call/tool-result parts from legacy messages");
        toolPartsWarningLogged = true;
      }

      // Build message content: text + images or just text or empty
      if (textParts.length > 0 || imageParts.length > 0) {
        if (textParts.length > 0 && imageParts.length > 0) {
          // Multi-modal: [text, ...images]
          const msgContent: ContentPart[] = [
            { type: "text", text: textParts.join("") },
            ...imageParts,
          ];
          // System messages cannot have multi-modal content; fallback to text only
          if (role === "system") {
            result.push({ role, content: textParts.join("") });
          } else if (role === "user") {
            result.push({ role: "user", content: msgContent });
          } else {
            result.push({ role: "assistant", content: textParts.join("") });
          }
        } else if (imageParts.length > 0) {
          // Images only
          if (role === "system") {
            result.push({ role, content: "" });
          } else if (role === "user") {
            result.push({ role: "user", content: imageParts });
          } else {
            result.push({ role: "assistant", content: "" });
          }
        } else {
          // Text only
          result.push({ role, content: textParts.join("") });
        }
      } else {
        // Empty after filtering tool parts
        result.push({ role, content: "" });
      }
      continue;
    }

    // Unknown shape: skip without throwing
  }

  return result;
}
