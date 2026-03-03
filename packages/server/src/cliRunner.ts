/**
 * cliRunner.ts
 * 通过已安装的 CLI 工具（Claude Code SDK / Gemini CLI）运行 AI Agent。
 * 适用于在服务器上使用 Pro 订阅额度、无需消耗 API Key 的场景。
 */
import { spawn } from "child_process";
import type { AgentSession, StreamEvent } from "./agent.js";

// ── 进程树终止工具（移植自 clawdbot/src/process/kill-tree.ts）────────────

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 跨平台进程树终止：先 SIGTERM，等待 grace 后 SIGKILL。
 * 使用进程组信号（kill -pid）确保子进程一并终止。
 */
function killProcessTree(pid: number, graceMs = 3000): void {
  if (!Number.isFinite(pid) || pid <= 0) return;

  if (process.platform === "win32") {
    // Windows：taskkill /T 包含子进程，先优雅，再强制
    try {
      spawn("taskkill", ["/T", "/PID", String(pid)], { stdio: "ignore", detached: true });
    } catch { /* ignore */ }
    setTimeout(() => {
      if (!isProcessAlive(pid)) return;
      try {
        spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", detached: true });
      } catch { /* ignore */ }
    }, graceMs).unref();
    return;
  }

  // Unix：向进程组发 SIGTERM，等待后 SIGKILL
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try { process.kill(pid, "SIGTERM"); } catch { return; }
  }
  setTimeout(() => {
    if (isProcessAlive(-pid)) {
      try { process.kill(-pid, "SIGKILL"); return; } catch { /* fall through */ }
    }
    if (isProcessAlive(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }, graceMs).unref();
}

// ── Claude Code CLI Runner ────────────────────────────────

/**
 * 使用 claude CLI 子进程运行，解析 stream-json 格式的 NDJSON 输出。
 * 与 Gemini CLI runner 相同模式：spawn → stdin.end → 解析 stdout NDJSON。
 * 服务器上需要全局安装并认证：npm install -g @anthropic-ai/claude-code
 */
export async function runClaudeCodeAgent(
  session: AgentSession,
  userMessage: string,
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const claudePath = process.env.CLAUDE_CLI_PATH || "claude";

  const args = [
    "-p", userMessage,
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--dangerously-skip-permissions",
  ];

  if (session.customPrompt?.trim()) {
    args.push("--append-system-prompt", `\n\n## Project Instructions\n${session.customPrompt.trim()}`);
  }

  console.log(`[CLI] Claude Code: workspace=${session.workspace}, msg="${userMessage.slice(0, 80)}"`);

  // 清除 API key 环境变量，避免干扰 claude CLI 的 OAuth 认证
  // claude CLI 使用自己存储的 OAuth 凭证，不应使用服务器的 API key
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;

  const proc = spawn(claudePath, args, {
    cwd: session.workspace,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
    env,
  });

  // 立即关闭 stdin，防止 claude CLI 等待输入
  proc.stdin?.end();

  if (signal) {
    signal.addEventListener("abort", () => {
      if (proc.pid) killProcessTree(proc.pid);
      else proc.kill("SIGTERM");
    });
  }

  let fullText = "";
  let lineBuffer = "";
  let resultSuccess = false;

  return new Promise<void>((resolve) => {
    proc.stdout.on("data", (chunk: Buffer) => {
      lineBuffer += chunk.toString("utf-8");
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (parseClaudeLine(line, onEvent, (t) => { fullText += t; })) {
          resultSuccess = true;
        }
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      const msg = chunk.toString("utf-8").trim();
      if (msg) console.warn("[CLI] Claude Code stderr:", msg.slice(0, 300));
    });

    proc.on("close", (code) => {
      if (lineBuffer.trim()) {
        if (parseClaudeLine(lineBuffer, onEvent, (t) => { fullText += t; })) {
          resultSuccess = true;
        }
      }
      // claude CLI 有时即使成功也以非零退出码结束，已收到 result.success 则忽略
      if (code !== 0 && !signal?.aborted && !resultSuccess) {
        console.error(`[CLI] Claude Code exited with code ${code}`);
        onEvent({ type: "error", error: `Claude Code 进程异常退出 (code=${code})` });
      }
      session.messages.push({ role: "assistant", content: fullText || "(Claude Code completed)" });
      onEvent({ type: "done" });
      resolve();
    });

    proc.on("error", (err) => {
      console.error("[CLI] Failed to start Claude Code:", err.message);
      onEvent({
        type: "error",
        error: `无法启动 Claude Code CLI: ${err.message}。请确认已安装: npm install -g @anthropic-ai/claude-code`,
      });
      onEvent({ type: "done" });
      resolve();
    });
  });
}

/** 返回 true 表示收到了 result.subtype=success */
function parseClaudeLine(
  line: string,
  onEvent: (e: StreamEvent) => void,
  appendText: (t: string) => void
): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  let msg: any;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return false;
  }

  switch (msg.type) {
    case "system":
      if (msg.subtype === "init") {
        console.log(`[CLI] Claude Code session=${msg.session_id}, model=${msg.model}`);
      }
      break;

    case "assistant": {
      const content = msg.message?.content;
      if (!Array.isArray(content)) break;
      for (const block of content) {
        if (block.type === "text") {
          appendText(block.text);
          onEvent({ type: "text-delta", text: block.text });
        } else if (block.type === "tool_use") {
          onEvent({ type: "tool-call", toolName: block.name, args: block.input });
        }
      }
      break;
    }

    case "user": {
      const content = msg.message?.content;
      if (!Array.isArray(content)) break;
      for (const block of content) {
        if (block.type === "tool_result") {
          const resultText = Array.isArray(block.content)
            ? block.content.map((c: any) => (c.type === "text" ? c.text : "")).join("")
            : String(block.content ?? "");
          onEvent({ type: "tool-result", toolName: "_claude_tool", result: resultText });
        }
      }
      break;
    }

    case "result":
      if (msg.subtype !== "success") {
        const errMsg = Array.isArray(msg.errors) ? msg.errors.join(", ") : (msg.subtype ?? "unknown error");
        onEvent({ type: "error", error: `Claude Code 执行失败: ${errMsg}` });
      } else {
        console.log(`[CLI] Claude Code done. turns=${msg.num_turns}, cost=$${msg.total_cost_usd?.toFixed(4) ?? "?"}`);
        return true;
      }
      break;
  }
  return false;
}

// ── Gemini CLI Runner ─────────────────────────────────────

/**
 * Gemini CLI stream-json 事件结构（NDJSON，每行一个 JSON 对象）。
 * 实际格式参考: gemini --output-format stream-json 的输出
 */
interface GeminiStreamLine {
  type: "init" | "message" | "tool_use" | "tool_result" | "result" | "error";
  timestamp?: string;
  session_id?: string;
  model?: string;
  // message 事件（role 为 "user" 或 "assistant"）
  role?: "user" | "assistant";
  content?: string;
  delta?: boolean;
  // tool_use 事件
  tool_name?: string;
  tool_id?: string;
  parameters?: unknown;
  // tool_result 事件
  status?: "success" | "error";
  output?: unknown;
  // result/error 事件
  error?: { type?: string; message?: string } | string;
  stats?: unknown;
}

/**
 * 使用 Gemini CLI 子进程运行，解析 stream-json 格式的 NDJSON 输出。
 * 服务器上需要全局安装并认证 @google/gemini-cli：
 *   npm install -g @google/gemini-cli && gemini auth login
 */
export async function runGeminiCliAgent(
  session: AgentSession,
  userMessage: string,
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const geminiPath = process.env.GEMINI_CLI_PATH || "gemini";

  console.log(`[CLI] Gemini CLI: workspace=${session.workspace}, msg="${userMessage.slice(0, 80)}"`);

  // 构建 CLI 参数
  // -y/--yolo: 自动批准所有工具调用，无需交互
  // -o/--output-format stream-json: NDJSON 流式输出（每行一个 JSON 对象）
  const args = [
    "--prompt", userMessage,
    "--output-format", "stream-json",
    "--yolo",
  ];

  const geminiModel = process.env.GEMINI_CLI_MODEL;
  if (geminiModel) {
    args.push("--model", geminiModel);
  }

  // 默认不加载用户全局扩展（Figma、chrome-devtools 等），避免 chrome-devtools 挂起
  // -e/--extensions：只加载指定名称的扩展；传不存在的名称 = 跳过所有扩展加载
  // 如需保留特定扩展，设置 GEMINI_CLI_EXTENSIONS=ext1,ext2
  const extensions = process.env.GEMINI_CLI_EXTENSIONS?.split(",").filter(Boolean) ?? [];
  args.push("--extensions", ...(extensions.length > 0 ? extensions : ["__none__"]));

  // 清除 GOOGLE_CLOUD_PROJECT / GCLOUD_PROJECT 避免干扰 Gemini CLI 的项目选择
  const env = { ...process.env };
  delete env.GOOGLE_CLOUD_PROJECT;
  delete env.GCLOUD_PROJECT;

  const proc = spawn(geminiPath, args, {
    cwd: session.workspace,
    stdio: ["pipe", "pipe", "pipe"],
    // Unix 上独立进程组，便于 kill-tree 终止整个子进程树
    detached: process.platform !== "win32",
    windowsHide: true,
    env,
  });

  // 立即关闭 stdin，向 Gemini CLI 发送 EOF 信号
  // 若 stdin 保持 pipe 开放，CLI 可能一直等待输入而不产生输出
  proc.stdin?.end();

  if (signal) {
    signal.addEventListener("abort", () => {
      if (proc.pid) killProcessTree(proc.pid);
      else proc.kill("SIGTERM");
    });
  }

  let fullText = "";
  let lineBuffer = "";

  return new Promise<void>((resolve) => {
    proc.stdout.on("data", (chunk: Buffer) => {
      lineBuffer += chunk.toString("utf-8");
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        parseLine(line, onEvent, (t) => { fullText += t; });
      }
    });

    // stderr 只记录日志，不暴露给用户（gemini 有大量状态信息输出到 stderr）
    proc.stderr.on("data", (chunk: Buffer) => {
      const msg = chunk.toString("utf-8").trim();
      if (msg) console.warn("[CLI] Gemini stderr:", msg.slice(0, 300));
    });

    proc.on("close", (code) => {
      // 处理最后一行未换行的 buffer
      if (lineBuffer.trim()) {
        parseLine(lineBuffer, onEvent, (t) => { fullText += t; });
      }
      if (code !== 0 && !signal?.aborted) {
        console.error(`[CLI] Gemini CLI exited with code ${code}`);
        onEvent({ type: "error", error: `Gemini CLI 进程异常退出 (code=${code})` });
      }
      session.messages.push({ role: "assistant", content: fullText || "(Gemini CLI completed)" });
      onEvent({ type: "done" });
      resolve();
    });

    proc.on("error", (err) => {
      console.error("[CLI] Failed to start Gemini CLI:", err.message);
      onEvent({
        type: "error",
        error: `无法启动 Gemini CLI: ${err.message}。请确认已安装: npm install -g @google/gemini-cli`,
      });
      onEvent({ type: "done" });
      resolve();
    });
  });
}

function parseLine(
  line: string,
  onEvent: (e: StreamEvent) => void,
  appendText: (t: string) => void
) {
  const trimmed = line.trim();
  if (!trimmed) return;
  let evt: GeminiStreamLine;
  try {
    evt = JSON.parse(trimmed);
  } catch {
    // 非 JSON 行（如 ANSI 彩色文本）直接忽略
    return;
  }
  switch (evt.type) {
    case "init":
      console.log(`[CLI] Gemini session=${evt.session_id}, model=${evt.model}`);
      break;
    case "message":
      if (evt.role === "assistant" && evt.content) {
        appendText(evt.content);
        onEvent({ type: "text-delta", text: evt.content });
      }
      break;
    case "tool_use":
      if (evt.tool_name) {
        onEvent({ type: "tool-call", toolName: evt.tool_name, args: evt.parameters ?? {} });
      }
      break;
    case "tool_result":
      if (evt.tool_id) {
        onEvent({ type: "tool-result", toolName: evt.tool_id, result: evt.output ?? {} });
      }
      break;
    case "result":
      if (evt.status === "error" && evt.error) {
        const errMsg = typeof evt.error === "string" ? evt.error : (evt.error.message ?? "Gemini CLI 执行失败");
        onEvent({ type: "error", error: errMsg });
      }
      // status === "success" 无需额外处理，proc.on("close") 会发出 done
      break;
    case "error":
      onEvent({ type: "error", error: typeof evt.error === "string" ? evt.error : "Gemini CLI 未知错误" });
      break;
  }
}
