import { describe, it, expect } from "vitest";
import { buildSystemPrompt, buildGoalInjection, goalKickoffPrompt, GOAL_CONTINUATION_PROMPT } from "./prompt.js";

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

describe("buildSystemPrompt 后台能力门控", () => {
  it("supportsBackground=true 时含 runInBackground", () => {
    const p = buildSystemPrompt({ supportsBackground: true });
    expect(p).toContain("runInBackground");
  });

  it("supportsBackground=false 时不含 runInBackground/stopProcess", () => {
    const p = buildSystemPrompt({ supportsBackground: false });
    expect(p).not.toContain("runInBackground");
    expect(p).not.toContain("stopProcess");
  });

  it("默认(不传)含 runInBackground(保持 App 现状)", () => {
    const p = buildSystemPrompt({});
    expect(p).toContain("runInBackground");
  });
});

describe("goal prompts (P16)", () => {
  it("buildGoalInjection contains goal text, progress, tool directive and non-override warning", () => {
    const inj = buildGoalInjection({ goal: "清零 lint 错误", acceptance: "pnpm lint 通过", turns: 3, maxTurns: 20 });
    expect(inj).toContain("清零 lint 错误");
    expect(inj).toContain("pnpm lint 通过");
    expect(inj).toContain("3/20");
    expect(inj).toContain("updateGoalStatus");
    expect(inj).toContain("不可覆盖"); // goal 文本是用户数据,不可覆盖系统指令
    expect(inj).toMatch(/complete/i);
    expect(inj).toMatch(/blocked/i);
  });

  it("kickoff/continuation prompt shapes", () => {
    const kick = goalKickoffPrompt({ goal: "清零 lint 错误", acceptance: "pnpm lint 通过" });
    expect(kick.startsWith("[goal]")).toBe(true);
    expect(kick).toContain("清零 lint 错误");
    expect(kick).toContain("pnpm lint 通过");
    expect(goalKickoffPrompt({ goal: "x" })).toContain("x");
    expect(GOAL_CONTINUATION_PROMPT.startsWith("[goal continuation]")).toBe(true);
    expect(GOAL_CONTINUATION_PROMPT).toContain("updateGoalStatus");
  });
});
