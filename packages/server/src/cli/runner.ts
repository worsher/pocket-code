// ── 通用 CLI Agent 运行器 ──────────────────────────────────
// 用一个 CliAgentAdapter 驱动子进程,把其 NDJSON 输出归一化为 AgentEvent 流。
// 与具体 CLI 解耦:进程生命周期/行缓冲/abort/退出码判定在此,解析在适配器。
// spawnFn 可注入,便于单测(默认用 child_process.spawn)。

import { spawn as nodeSpawn } from "node:child_process";
import type { AgentEventType } from "@pocket-code/wire";
import type { CliAgentAdapter, CliSpawnContext } from "./types.js";
import { killProcessTree } from "../processKill.js";

export type SpawnFn = typeof nodeSpawn;

/** 无任何 stdout/stderr 活动的最长等待时间;超时视为 CLI 卡死,强制终止。 */
const IDLE_TIMEOUT_MS = 120000;

/**
 * 运行一个 CLI 代理。把适配器解析出的 AgentEvent 通过 onEvent 流式发出,
 * 结尾必发一个 done。返回累计的 assistant 文本(供上层写入会话历史)与(若适配器
 * 支持)首次从输出中采集到的底层 CLI session_id(供上层持久化以便下轮 --resume)。
 */
export async function runCliAgent(
  adapter: CliAgentAdapter,
  userMessage: string,
  ctx: CliSpawnContext,
  onEvent: (event: AgentEventType) => void,
  signal?: AbortSignal,
  spawnFn: SpawnFn = nodeSpawn
): Promise<{ fullText: string; cliSessionId?: string }> {
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

  return new Promise<{ fullText: string; cliSessionId?: string }>((resolve) => {
    let cliSessionId: string | undefined;
    let stderrTail = "";
    let idleTimer: NodeJS.Timeout | undefined;

    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        handle({ type: "error", message: "CLI 无响应,已终止(120s 无输出)" });
        if (proc.pid) killProcessTree(proc.pid); // → 触发 close → resolve
      }, IDLE_TIMEOUT_MS);
    };
    resetIdle();

    const drainLine = (line: string) => {
      if (!cliSessionId && adapter.extractSessionId) {
        const sid = adapter.extractSessionId(line);
        if (sid) cliSessionId = sid;
      }
      for (const ev of parse(line)) handle(ev);
    };

    proc.stdout?.on("data", (chunk: Buffer) => {
      resetIdle();
      lineBuffer += chunk.toString("utf-8");
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) drainLine(line);
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      resetIdle();
      const msg = chunk.toString("utf-8").trim();
      if (msg) console.warn(`[CLI:${adapter.id}] stderr:`, msg.slice(0, 300));
      stderrTail = (stderrTail + msg).slice(-2048);
    });

    proc.on("close", (code: number | null) => {
      if (idleTimer) clearTimeout(idleTimer);
      if (lineBuffer.trim()) drainLine(lineBuffer);
      // CLI 常以非零码退出却实际成功:只有"零输出且非中止且未报错"才判为失败。
      if (code !== 0 && !signal?.aborted && !producedOutput && !errorEmitted) {
        const tail = stderrTail.trim() ? `\n${stderrTail.trim()}` : "";
        handle({ type: "error", message: `${adapter.id} 进程异常退出 (code=${code})${tail}` });
      }
      onEvent({ type: "done" });
      resolve({ fullText, cliSessionId });
    });

    proc.on("error", (err: Error) => {
      if (idleTimer) clearTimeout(idleTimer);
      if (!errorEmitted) {
        onEvent({
          type: "error",
          message: `无法启动 ${adapter.id}: ${err.message}`,
        });
      }
      onEvent({ type: "done" });
      resolve({ fullText, cliSessionId });
    });
  });
}
