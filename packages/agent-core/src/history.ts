/**
 * Legacy AI SDK message history converter.
 * Converts old format messages to CoreMessage format with best-effort approach.
 */

import type { CoreMessage, ContentPart } from "./types.js";

const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Isomorphic base64 encoder (RFC4648, standard alphabet + padding).
 * Avoids relying on Buffer (Node-only) or btoa (unreliable/unavailable in core's
 * runtime-agnostic environment).
 */
export function bytesToBase64(bytes: number[]): string {
  let result = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined;

    result += BASE64_CHARS[b0 >> 2];
    result += BASE64_CHARS[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    result += b1 !== undefined ? BASE64_CHARS[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)] : "=";
    result += b2 !== undefined ? BASE64_CHARS[b2 & 0x3f] : "=";
  }
  return result;
}

/**
 * Detects the legacy DB shape of an image part's `image` field: a Uint8Array
 * that was JSON.stringify-d, producing a plain object with numeric string keys
 * (e.g. {"0":137,"1":80,...}).
 */
function isNumericKeyedByteObject(value: unknown): value is Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length === 0) {
    return false;
  }
  if ("0" in value) {
    return true;
  }
  return keys.every((k) => /^\d+$/.test(k));
}

export function fromLegacyAiSdkMessages(raw: unknown[]): CoreMessage[] {
  const result: CoreMessage[] = [];
  let toolPartsWarningLogged = false;
  let imageDropWarned = false;

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
        } else if (partType === "image" && isNumericKeyedByteObject(p.image) && typeof p.mimeType === "string") {
          // Legacy DB shape: a Uint8Array that was JSON.stringify-d into a
          // numeric-keyed object (e.g. {"0":137,"1":80,...}). Rebuild the byte
          // array and re-encode as base64.
          const byteObj = p.image;
          const bytes = Object.keys(byteObj)
            .map((k) => Number(k))
            .sort((a, b) => a - b)
            .map((k) => byteObj[String(k)]);
          imageParts.push({
            type: "image",
            base64: bytesToBase64(bytes),
            mimeType: p.mimeType,
          });
        } else if (partType === "image") {
          // Unrecognized image shape: drop it, but warn once so silent data
          // loss doesn't go unnoticed.
          if (!imageDropWarned) {
            console.warn("[fromLegacyAiSdkMessages] Dropped unrecognized image part shape");
            imageDropWarned = true;
          }
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
