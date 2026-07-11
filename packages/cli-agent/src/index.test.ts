import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cliAdapters, runCliAgent, killProcessTree, isCliEvent } from "./index.js";

const SRC = dirname(fileURLToPath(import.meta.url));

describe("入口导出面 smoke", () => {
  it("注册表含三适配器", () => {
    expect(Object.keys(cliAdapters).sort()).toEqual(["claude-code", "codex", "gemini-cli"]);
  });
  it("核心导出可用", () => {
    expect(typeof runCliAgent).toBe("function");
    expect(typeof killProcessTree).toBe("function");
    expect(typeof isCliEvent).toBe("function");
  });
});

describe("隔离断言(随时可迁不变量)", () => {
  it("src 内零 @pocket-code/wire、零 AgentSession、零越包相对引用", () => {
    for (const f of readdirSync(SRC).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))) {
      const text = readFileSync(join(SRC, f), "utf-8");
      expect(text, `${f} 引用了 wire`).not.toContain("@pocket-code/wire");
      expect(text, `${f} 引用了 AgentSession`).not.toContain("AgentSession");
      expect(text, `${f} 有越包相对引用`).not.toContain("from \"../");
    }
  });
  it("package.json dependencies 为空(零运行时依赖)", () => {
    const pkg = JSON.parse(readFileSync(join(SRC, "..", "package.json"), "utf-8"));
    expect(pkg.dependencies).toEqual({});
    expect(Object.keys(pkg.devDependencies)).not.toContain("@pocket-code/wire");
  });
});
