import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliEvent } from "./types.js";
import { isCliEvent } from "./isCliEvent.js";
import { runCliAgent } from "./runner.js";
import { claudeCodeAdapter } from "./claudeCode.js";

function claudeAvailable(): boolean {
  try {
    execSync("command -v claude", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const ENABLED = !!process.env.RUN_CLI_E2E && claudeAvailable();

// 默认跳过:CI 无 claude、日常 test 无 RUN_CLI_E2E。仅手动 `RUN_CLI_E2E=1 pnpm --filter @pocket-code/cli-agent test` 且本机装了 claude 时运行。
describe.skipIf(!ENABLED)("claude-code E2E (real CLI)", () => {
  it("drives real claude to write a file and emits well-formed CliEvents", async () => {
    const ws = mkdtempSync(join(tmpdir(), "pc-e2e-"));
    const events: CliEvent[] = [];

    const { fullText } = await runCliAgent(
      claudeCodeAdapter,
      "Create a file named hello.txt containing exactly the text: hi. Then stop.",
      { workspace: ws },
      (e) => events.push(e)
    );

    // 每个事件都合法
    for (const e of events) {
      expect(isCliEvent(e)).toBe(true);
    }
    // 末事件为 done
    expect(events[events.length - 1].type).toBe("done");
    // 至少产生了文本或工具调用
    const types = new Set(events.map((e) => e.type));
    expect(types.has("text-delta") || types.has("tool-call")).toBe(true);
    // 真机确实写出了文件
    expect(existsSync(join(ws, "hello.txt"))).toBe(true);
    expect(readFileSync(join(ws, "hello.txt"), "utf-8").trim()).toBe("hi");
    // 返回的累计文本是字符串
    expect(typeof fullText).toBe("string");
  }, 120000);
});
