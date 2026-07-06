import { describe, it, expect } from "vitest";
import { fromLegacyAiSdkMessages } from "./history.js";

describe("fromLegacyAiSdkMessages", () => {
  it("passes through plain role/content strings", () => {
    expect(fromLegacyAiSdkMessages([
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
    ])).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
    ]);
  });
  it("flattens text parts and keeps image parts; drops tool parts", () => {
    const out = fromLegacyAiSdkMessages([
      { role: "user", content: [{ type: "text", text: "look" }, { type: "image", image: "AAA", mimeType: "image/png" }] },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "t", toolName: "x", args: {} }] },
    ]);
    expect(out[0]).toEqual({ role: "user", content: [{ type: "text", text: "look" }, { type: "image", base64: "AAA", mimeType: "image/png" }] });
    expect(out[1]).toEqual({ role: "assistant", content: "" });
  });
  it("skips unknown shapes without throwing", () => {
    expect(fromLegacyAiSdkMessages([null, 42, { nope: true }])).toEqual([]);
  });
});
