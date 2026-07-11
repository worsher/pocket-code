// ── 通用 CLI Agent 运行器 ──────────────────────────────────
// 用一个 CliAgentAdapter 驱动子进程,把其 NDJSON 输出归一化为 AgentEvent 流。
// 与具体 CLI 解耦:进程生命周期/行缓冲/abort/退出码判定在此,解析在适配器。
// spawnFn 可注入,便于单测(默认用 child_process.spawn)。

import { spawn as nodeSpawn } from "node:child_process";
import type { AgentEventType } from "@pocket-code/wire";
import type { CliAgentAdapter, CliSpawnContext } from "./types.js";
import { killProcessTree } from "../processKill.js";

export type SpawnFn = typeof nodeSpawn;

/**
 * 运行一个 CLI 代理。把适配器解析出的 AgentEvent 通过 onEvent 流式发出,
 * 结尾必发一个 done。返回累计的 assistant 文本(供上层写入会话历史)。
 */
export async function runCliAgent(
  adapter: CliAgentAdapter,
  userMessage: string,
  ctx: CliSpawnContext,
  onEvent: (event: AgentEventType) => void,
  signal?: AbortSignal,
  spawnFn: SpawnFn = nodeSpawn
): Promise<string> {
  const spec = adapter.buildSpawn(userMessage, ctx);

  const parse =
    adapter.createParser?.() ??
    (adapter.parseLine ? adapter.parseLine.bind(adapter) : undefined);
  if (!parse) {
    throw new Error(`adapter ${adapter.id} must implement parseLine or createParser`);
  }

  const proc = spawnFn(spec.cmd, spec.args, {
    cwd: spec.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
    env: spec.env,
  });

  // 立即关闭 stdin,避免 CLI 等待输入(真机实测会等 3s)。
  proc.stdin?.end();

  if (signal) {
    signal.addEventListener("abort", () => {
      if (proc.pid) killProcessTree(proc.pid);
      else proc.kill("SIGTERM");
    });
  }

  let fullText = "";
  let lineBuffer = "";
  let producedOutput = false;
  let errorEmitted = false;

  const handle = (event: AgentEventType) => {
    if (event.type === "text-delta") fullText += event.text;
    if (event.type === "error") {
      errorEmitted = true;
      // CLI 的 API 错误走 NDJSON in-band(不进 stderr),不落日志的话本地毫无痕迹
      console.error(`[CLI:${adapter.id}] error event:`, event.message.slice(0, 300));
    }
    if (event.type !== "done") producedOutput = true;
    onEvent(event);
  };

  const drainLine = (line: string) => {
    for (const ev of parse(line)) handle(ev);
  };

  return new Promise<string>((resolve) => {
    proc.stdout?.on("data", (chunk: Buffer) => {
      lineBuffer += chunk.toString("utf-8");
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) drainLine(line);
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      const msg = chunk.toString("utf-8").trim();
      if (msg) console.warn(`[CLI:${adapter.id}] stderr:`, msg.slice(0, 300));
    });

    proc.on("close", (code: number | null) => {
      if (lineBuffer.trim()) drainLine(lineBuffer);
      // CLI 常以非零码退出却实际成功:只有"零输出且非中止且未报错"才判为失败。
      if (code !== 0 && !signal?.aborted && !producedOutput && !errorEmitted) {
        handle({ type: "error", message: `${adapter.id} 进程异常退出 (code=${code})` });
      }
      onEvent({ type: "done" });
      resolve(fullText);
    });

    proc.on("error", (err: Error) => {
      if (!errorEmitted) {
        onEvent({
          type: "error",
          message: `无法启动 ${adapter.id}: ${err.message}`,
        });
      }
      onEvent({ type: "done" });
      resolve(fullText);
    });
  });
}
