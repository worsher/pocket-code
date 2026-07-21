// ── P15:token 粗估(spec §6.1)────────────────────────────
// 只用于压缩触发判断:粗但单调。文本 ceil(len/4);image part 固定 1500;
// 每条消息 +4 结构开销。不追求与任何 tokenizer 对齐。

import type { CoreMessage } from "./types.js";

const IMAGE_TOKENS = 1500;
const PER_MESSAGE_OVERHEAD = 4;

function textTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

export function estimateTokens(messages: CoreMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += PER_MESSAGE_OVERHEAD;
    switch (msg.role) {
      case "system":
        total += textTokens(msg.content);
        break;
      case "user":
        if (typeof msg.content === "string") {
          total += textTokens(msg.content);
        } else {
          for (const part of msg.content) {
            total += part.type === "image" ? IMAGE_TOKENS : textTokens(part.text);
          }
        }
        break;
      case "assistant":
        total += textTokens(msg.content);
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) total += textTokens(tc.name + JSON.stringify(tc.args));
        }
        break;
      case "tool":
        total += textTokens(msg.content);
        break;
    }
  }
  return total;
}
