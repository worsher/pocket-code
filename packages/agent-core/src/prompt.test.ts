import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "./prompt.js";

describe("buildSystemPrompt", () => {
  it("buildSystemPrompt({}) should be non-empty and contain key sentences", () => {
    const prompt = buildSystemPrompt({});
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain("Pocket Code");
    expect(prompt).toContain("mobile device");
    expect(prompt).toContain("workspace");
  });

  it("buildSystemPrompt({customPrompt:'X'}) should end with customPrompt", () => {
    const customPrompt = "Custom instructions here";
    const prompt = buildSystemPrompt({ customPrompt });
    expect(prompt).toContain("\n\n## Project Instructions\n" + customPrompt);
    expect(prompt.endsWith(customPrompt)).toBe(true);
  });
});
