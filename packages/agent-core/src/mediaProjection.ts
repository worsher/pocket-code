// ── 媒体投影(spec 2026-07-21 §4.3)──────────────────────────
// 请求体过大(413)/图片被拒时,把 history 的图片 ContentPart 替换为文本占位符
// 后重发。纯函数、不改入参:投影只作用于发给 ModelClient 的副本,session 的
// messages 本体与落库内容在任何降级路径下逐字节不变(C13-3)。

import type { ContentPart, CoreMessage } from "./types.js";

export type MediaProjection = "normal" | "degraded" | "stripped";

export const MEDIA_PLACEHOLDER = "[图片已省略:为控制请求体积,此前上传的图片已从上下文移除]";

/** 统计全部消息中的 image ContentPart 数。 */
export function countImages(messages: CoreMessage[]): number {
  let n = 0;
  for (const msg of messages) {
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (const part of msg.content) if (part.type === "image") n++;
    }
  }
  return n;
}

/**
 * degraded:除全局最后一个 image 外,其余替换为占位文本(保留最近一张);
 * stripped:全部替换;normal:原样返回入参引用。幂等(C13-4)。
 */
export function projectMedia(messages: CoreMessage[], level: MediaProjection): CoreMessage[] {
  if (level === "normal") return messages;

  // 定位全局最后一个 image part(degraded 的保留位)
  let keepMsg = -1;
  let keepPart = -1;
  if (level === "degraded") {
    for (let m = 0; m < messages.length; m++) {
      const msg = messages[m];
      if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
      for (let p = 0; p < msg.content.length; p++) {
        if (msg.content[p].type === "image") {
          keepMsg = m;
          keepPart = p;
        }
      }
    }
  }

  return messages.map((msg, m) => {
    if (msg.role !== "user" || !Array.isArray(msg.content)) return msg;
    if (!msg.content.some((part) => part.type === "image")) return msg;
    const content: ContentPart[] = msg.content.map((part, p) => {
      if (part.type !== "image") return part;
      if (m === keepMsg && p === keepPart) return part;
      return { type: "text", text: MEDIA_PLACEHOLDER };
    });
    return { ...msg, content };
  });
}
