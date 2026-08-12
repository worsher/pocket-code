import { describe, expect, it } from "vitest";
import { getKeyboardVerticalOffset } from "./keyboardLayout";

describe("getKeyboardVerticalOffset", () => {
  it("includes the header above the avoiding view on Android", () => {
    expect(getKeyboardVerticalOffset("android", 24, 48)).toBe(72);
  });

  it("preserves the existing safe-area offset on iOS", () => {
    expect(getKeyboardVerticalOffset("ios", 47, 48)).toBe(47);
  });
});
