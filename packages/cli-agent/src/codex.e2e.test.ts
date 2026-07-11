import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliEvent } from "./types.js";
import { isCliEvent } from "./isCliEvent.js";
import { runCliAgent } from "./runner.js";
import { codexAdapter } from "./codex.js";

function cliAvailable(): boolean {
  try { execSync("command -v codex", { stdio: "ignore" }); return true; } catch { return false; }
}
const ENABLED = !!process.env.RUN_CLI_E2E && cliAvailable();

// 手动 RUN_CLI_E2E=1 且本机 codex 已登录时运行;依赖账号/网络可用。
describe.skipIf(!ENABLED)("codex E2E (real CLI)", () => {
  it("drives real codex to write a file and emits well-formed CliEvents", async () => {
    const ws = mkdtempSync(join(tmpdir(), "pc-e2e-codex-"));
    const events: CliEvent[] = [];
    await runCliAgent(
      codexAdapter,
      "Create a file named hello.txt containing exactly the text: hi. Then stop.",
      { workspace: ws },
      (e) => events.push(e)
    );
    for (const ev of events) expect(isCliEvent(ev)).toBe(true);
    expect(events.at(-1)?.type).toBe("done");
    expect(existsSync(join(ws, "hello.txt"))).toBe(true);
    expect(readFileSync(join(ws, "hello.txt"), "utf-8").trim()).toBe("hi");
  }, 300_000);
});
