import { describe, it, expect } from "vitest";
import { projectMedia, countImages, MEDIA_PLACEHOLDER } from "./mediaProjection.js";
import type { CoreMessage } from "./types.js";

const img = (b64: string) => ({ type: "image" as const, base64: b64, mimeType: "image/png" });
const history: CoreMessage[] = [
  { role: "user", content: [{ type: "text", text: "看图1" }, img("AAA")] },
  { role: "assistant", content: "ok" },
  { role: "user", content: [{ type: "text", text: "图2和图3" }, img("BBB"), img("CCC")] },
  { role: "user", content: "纯文本" },
];

describe("projectMedia", () => {
  it("degraded keeps only the globally last image; others become placeholder text (C13-4)", () => {
    const out = projectMedia(history, "degraded");
    expect(countImages(out)).toBe(1);
    const parts = (out[2] as any).content;
    expect(parts[1]).toEqual({ type: "text", text: MEDIA_PLACEHOLDER }); // BBB 被替换
    expect(parts[2]).toMatchObject({ type: "image", base64: "CCC" }); // 最后一张保留
    expect(((out[0] as any).content)[1]).toEqual({ type: "text", text: MEDIA_PLACEHOLDER });
  });

  it("stripped removes every image", () => {
    expect(countImages(projectMedia(history, "stripped"))).toBe(0);
  });

  it("does NOT mutate input (C13-3 基础)", () => {
    const snapshot = JSON.stringify(history);
    projectMedia(history, "stripped");
    projectMedia(history, "degraded");
    expect(JSON.stringify(history)).toBe(snapshot);
  });

  it("idempotent: projecting a projection is deep-equal (C13-4)", () => {
    const once = projectMedia(history, "degraded");
    expect(projectMedia(once, "degraded")).toEqual(once);
    const strippedOnce = projectMedia(history, "stripped");
    expect(projectMedia(strippedOnce, "stripped")).toEqual(strippedOnce);
  });

  it("normal returns the same reference; text-only history unchanged", () => {
    expect(projectMedia(history, "normal")).toBe(history);
    const textOnly: CoreMessage[] = [{ role: "user", content: "hi" }];
    expect(projectMedia(textOnly, "stripped")).toEqual(textOnly);
  });
});
