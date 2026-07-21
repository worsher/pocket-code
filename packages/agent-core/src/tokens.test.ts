import { describe, it, expect } from "vitest";
import { estimateTokens } from "./tokens.js";
import type { CoreMessage } from "./types.js";

describe("estimateTokens", () => {
  it("text length monotonic; per-message overhead counted", () => {
    const short: CoreMessage[] = [{ role: "user", content: "abcd" }];
    const long: CoreMessage[] = [{ role: "user", content: "abcd".repeat(100) }];
    expect(estimateTokens(short)).toBeGreaterThan(0);
    expect(estimateTokens(long)).toBeGreaterThan(estimateTokens(short));
    // ceil(4/4)=1 + 4 开销 = 5
    expect(estimateTokens(short)).toBe(5);
  });

  it("image parts cost a flat 1500 each", () => {
    const noImg: CoreMessage[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    const oneImg: CoreMessage[] = [
      { role: "user", content: [{ type: "text", text: "hi" }, { type: "image", base64: "AAA", mimeType: "image/png" }] },
    ];
    expect(estimateTokens(oneImg) - estimateTokens(noImg)).toBe(1500);
  });

  it("assistant toolCalls and tool messages contribute", () => {
    const msgs: CoreMessage[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "readFile", args: { path: "a".repeat(400) } }] },
      { role: "tool", toolCallId: "c1", toolName: "readFile", content: "x".repeat(4000) },
    ];
    // tool content 4000/4=1000 起步
    expect(estimateTokens(msgs)).toBeGreaterThan(1000);
  });
});
