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

  it("first paragraph matches server SYSTEM_PROMPT verbatim (anti wording-drift)", () => {
    const prompt = buildSystemPrompt({});
    // Verbatim from packages/server/src/agent.ts SYSTEM_PROMPT first paragraph.
    expect(prompt).toContain(
      "You are Pocket Code, an AI coding assistant running on a mobile device. You help developers write, debug, and manage code through natural conversation."
    );
    expect(prompt).toContain(
      "You have access to a workspace directory where you can read/write files and execute commands. Use the tools provided to help the user."
    );
  });

  it("buildSystemPrompt({customPrompt:'X'}) should end with customPrompt", () => {
    const customPrompt = "Custom instructions here";
    const prompt = buildSystemPrompt({ customPrompt });
    expect(prompt).toContain("\n\n## Project Instructions\n" + customPrompt);
    expect(prompt.endsWith(customPrompt)).toBe(true);
  });
});
