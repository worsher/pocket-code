import { describe, it, expect, vi, afterEach } from "vitest";
import { fromLegacyAiSdkMessages, bytesToBase64 } from "./history.js";

describe("bytesToBase64", () => {
  it("encodes empty array as empty string", () => {
    expect(bytesToBase64([])).toBe("");
  });

  it("encodes [72,105] as 'SGk=' (matches Node Buffer.from([72,105]).toString('base64'))", () => {
    expect(bytesToBase64([72, 105])).toBe("SGk=");
  });
});

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

  it("converts numeric-keyed byte-object image parts (legacy DB Uint8Array JSON shape)", () => {
    // {"0":72,"1":105} is what JSON.stringify(new Uint8Array([72,105])) round-trips to.
    const out = fromLegacyAiSdkMessages([
      { role: "user", content: [{ type: "image", image: { "0": 72, "1": 105 }, mimeType: "image/png" }] },
    ]);
    expect(out[0]).toEqual({
      role: "user",
      content: [{ type: "image", base64: "SGk=", mimeType: "image/png" }],
    });
  });

  it("drops unrecognized image part shapes and warns once", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = fromLegacyAiSdkMessages([
      { role: "user", content: [{ type: "text", text: "a" }, { type: "image", image: 12345, mimeType: "image/png" }] },
      { role: "user", content: [{ type: "image", image: null, mimeType: "image/png" }] },
    ]);
    expect(out[0]).toEqual({ role: "user", content: "a" });
    expect(out[1]).toEqual({ role: "user", content: "" });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
