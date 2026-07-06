import { describe, it, expect } from "vitest";
import { callbacksToAsyncIterable, toChatMessages } from "./rnModelClient";

describe("callbacksToAsyncIterable", () => {
  it("yields deltas in order and completes on onDone", async () => {
    const it_ = callbacksToAsyncIterable(({ onDelta, onDone }) => {
      onDelta({ type: "text", text: "a" });
      setTimeout(() => { onDelta({ type: "text", text: "b" }); onDone(); }, 5);
    });
    const got: any[] = [];
    for await (const d of it_) got.push(d);
    expect(got.map((d) => d.text)).toEqual(["a", "b"]);
  });
  it("onError rejects the iteration", async () => {
    const it_ = callbacksToAsyncIterable(({ onError }) => setTimeout(() => onError("boom"), 1));
    await expect((async () => { for await (const _ of it_) {/**/} })()).rejects.toThrow("boom");
  });
});

describe("toChatMessages", () => {
  it("converts tool round trips to OpenAI shapes", () => {
    const out = toChatMessages([
      { role: "user", content: "hi" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "readFile", args: { path: "a" } }] },
      { role: "tool", toolCallId: "c1", toolName: "readFile", content: "{\"ok\":true}" },
    ]);
    expect(out[1]).toMatchObject({ role: "assistant", tool_calls: [{ id: "c1", function: { name: "readFile" } }] });
    expect(out[2]).toMatchObject({ role: "tool", tool_call_id: "c1" });
  });
  it("converts image parts to data-URI image_url", () => {
    const out = toChatMessages([{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", base64: "AAA", mimeType: "image/png" }] }]);
    expect((out[0] as any).content[1].image_url.url).toBe("data:image/png;base64,AAA");
  });
});
