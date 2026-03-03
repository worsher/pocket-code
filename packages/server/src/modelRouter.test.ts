import { describe, it, expect } from "vitest";
import { analyzePrompt, type PromptAnalysis } from "./modelRouter.js";

describe("modelRouter — analyzePrompt", () => {
    const emptyHistory: any[] = [];

    it("should classify simple greetings as simple", () => {
        const result = analyzePrompt("hello", emptyHistory);
        expect(result.complexity).toBe("simple");
        expect(result.suggestedModel).toBe("deepseek-v3");
    });

    it("should classify Chinese greetings as simple", () => {
        const result = analyzePrompt("你好", emptyHistory);
        expect(result.complexity).toBe("simple");
    });

    it("should classify git status as simple", () => {
        const result = analyzePrompt("git status", emptyHistory);
        expect(result.complexity).toBe("simple");
    });

    it("should classify algorithm questions as reasoning", () => {
        const result = analyzePrompt("请用动态规划解这道算法题", emptyHistory);
        expect(result.complexity).toBe("reasoning");
        expect(result.suggestedModel).toBe("deepseek-r1");
    });

    it("should classify design pattern questions as reasoning", () => {
        const result = analyzePrompt("分析这段代码使用了哪种设计模式，并解释其 trade-off", emptyHistory);
        expect(result.complexity).toBe("reasoning");
    });

    it("should classify refactoring requests as complex", () => {
        const result = analyzePrompt("请重构整个项目的架构", emptyHistory);
        expect(result.complexity).toBe("complex");
        expect(result.suggestedModel).toBe("claude-sonnet");
    });

    it("should classify image messages as complex", () => {
        const result = analyzePrompt("分析这个截图", emptyHistory, true);
        expect(result.complexity).toBe("complex");
        expect(result.suggestedModel).toBe("claude-sonnet");
    });

    it("should classify long prompts with deep history as complex", () => {
        const longMsg = "a ".repeat(120);
        const deepHistory = Array.from({ length: 25 }, () => ({
            role: "user" as const,
            content: "test",
        }));
        const result = analyzePrompt(longMsg, deepHistory);
        expect(result.complexity).toBe("complex");
    });

    it("should default to medium for normal coding requests", () => {
        const result = analyzePrompt("帮我写一个函数计算两数之和", emptyHistory);
        expect(result.complexity).toBe("medium");
        expect(result.suggestedModel).toBe("deepseek-v3");
    });
});
