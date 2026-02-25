/**
 * cliRunner.ts
 * 通过已安装的 CLI 工具（Claude Code SDK / Gemini CLI）运行 AI Agent。
 * 适用于在服务器上使用 Pro 订阅额度、无需消耗 API Key 的场景。
 */
import { spawn } from "child_process";
import type { AgentSession, StreamEvent } from "./agent.js";

// ── Claude Code SDK Runner ────────────────────────────────

/**
 * 使用 @anthropic-ai/claude-code 的 query() SDK 运行 Claude Code。
 * Claude Code 自己管理工具调用（文件读写、命令执行等），
 * 我们只需要将 SDK 消息格式转换为 StreamEvent。
 */
export async function runClaudeCodeAgent(
  session: AgentSession,
  userMessage: string,
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  let queryFn: any;
  try {
    // @ts-ignore — @anthropic-ai/claude-code is an optional runtime dependency
    const mod = await import("@anthropic-ai/claude-code");
    queryFn = mod.query;
  } catch {
    onEvent({
      type: "error",
      error: "Claude Code SDK 未安装。请在服务器上执行: npm install -g @anthropic-ai/claude-code",
    });
    onEvent({ type: "done" });
    return;
  }

  const abortController = new AbortController();
  if (signal) {
    signal.addEventListener("abort", () => abortController.abort());
  }

  console.log(`[CLI] Claude Code: workspace=${session.workspace}, msg="${userMessage.slice(0, 80)}"`);

  let fullText = "";

  try {
    for await (const message of queryFn({
      prompt: userMessage,
      abortController,
      options: {
        cwd: session.workspace,
        permissionMode: "bypassPermissions",
        appendSystemPrompt: session.customPrompt?.trim()
          ? `\n\n## Project Instructions\n${session.customPrompt.trim()}`
          : undefined,
      },
    })) {
      if (signal?.aborted) break;

      switch ((message as any).type) {
        case "system": {
          const sys = message as any;
          if (sys.subtype === "init") {
            console.log(`[CLI] Claude Code session=${sys.session_id}, model=${sys.model}`);
          }
          break;
        }

        case "assistant": {
          const content = (message as any).message?.content;
          if (!Array.isArray(content)) break;
          for (const block of content) {
            if (block.type === "text") {
              fullText += block.text;
              onEvent({ type: "text-delta", text: block.text });
            } else if (block.type === "tool_use") {
              onEvent({ type: "tool-call", toolName: block.name, args: block.input });
            }
          }
          break;
        }

        case "user": {
          const content = (message as any).message?.content;
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

        case "result": {
          const res = message as any;
          if (res.subtype !== "success") {
            const errMsg = Array.isArray(res.errors) ? res.errors.join(", ") : (res.subtype ?? "unknown error");
            onEvent({ type: "error", error: `Claude Code 执行失败: ${errMsg}` });
          } else {
            console.log(`[CLI] Claude Code done. turns=${res.num_turns}, cost=$${res.total_cost_usd?.toFixed(4) ?? "?"}`);
          }
          break;
        }
      }
    }

    session.messages.push({ role: "assistant", content: fullText || "(Claude Code completed)" });
    onEvent({ type: "done" });
  } catch (err: any) {
    if (err?.name === "AbortError") {
      onEvent({ type: "done" });
      return;
    }
    console.error("[CLI] Claude Code error:", err.message);
    onEvent({ type: "error", error: err.message });
    onEvent({ type: "done" });
  }
}

// ── Gemini CLI Runner ─────────────────────────────────────

/**
 * Gemini CLI stream-json 事件结构（NDJSON，每行一个 JSON 对象）。
 */
interface GeminiStreamLine {
  type: "message" | "tool_call" | "tool_result" | "error" | "done";
  role?: "user" | "assistant" | "tool";
  content?: string;
  name?: string;
  input?: unknown;
  result?: unknown;
  error?: string;
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
  // --yolo / --approval-mode yolo: 自动批准所有工具调用，无需交互
  // --output_format stream_json: NDJSON 流式输出
  const args = [
    "--prompt", userMessage,
    "--output_format", "stream_json",
    "--yolo",
  ];

  const geminiModel = process.env.GEMINI_CLI_MODEL;
  if (geminiModel) {
    args.push("--model", geminiModel);
  }

  const proc = spawn(geminiPath, args, {
    cwd: session.workspace,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  if (signal) {
    signal.addEventListener("abort", () => proc.kill("SIGTERM"));
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
    case "message":
      if (evt.role === "assistant" && evt.content) {
        appendText(evt.content);
        onEvent({ type: "text-delta", text: evt.content });
      }
      break;
    case "tool_call":
      if (evt.name) {
        onEvent({ type: "tool-call", toolName: evt.name, args: evt.input ?? {} });
      }
      break;
    case "tool_result":
      if (evt.name) {
        onEvent({ type: "tool-result", toolName: evt.name, result: evt.result ?? {} });
      }
      break;
    case "error":
      onEvent({ type: "error", error: evt.error || "Gemini CLI 未知错误" });
      break;
    case "done":
      // 正常结束标记，无需处理
      break;
  }
}
