/**
 * cliRunner.ts
 * 通过已安装的 CLI 工具（Claude Code / Gemini CLI）运行 AI Agent。
 * 适用于在服务器上使用 Pro 订阅额度、无需消耗 API Key 的场景。
 *
 * claude 路径复用 cli/ 下的 CliAgentAdapter + runCliAgent,直接产出归一化 AgentEvent;
 * gemini 路径在本文件内解析 stream-json 并同样归一化为 AgentEvent。
 */
import { spawn } from "child_process";
import type { AgentSession } from "./agent.js";
import { claudeCodeAdapter } from "./cli/claudeCode.js";
import { runCliAgent, killProcessTree } from "./cli/runner.js";
import type { AgentEventType } from "@pocket-code/wire";

// ── Claude Code CLI Runner ────────────────────────────────

/**
 * 使用 claude CLI 运行:经 claudeCodeAdapter 解析为归一化 AgentEvent,直接透传给调用方。
 * 服务器上需全局安装并认证:npm install -g @anthropic-ai/claude-code
 */
export async function runClaudeCodeAgent(
  session: AgentSession,
  userMessage: string,
  onEvent: (event: AgentEventType) => void,
  signal?: AbortSignal
): Promise<void> {
  console.log(`[CLI] Claude Code: workspace=${session.workspace}, msg="${userMessage.slice(0, 80)}"`);

  const fullText = await runCliAgent(
    claudeCodeAdapter,
    userMessage,
    { workspace: session.workspace, customPrompt: session.customPrompt },
    onEvent,
    signal
  );

  session.messages.push({ role: "assistant", content: fullText || "(Claude Code completed)" });
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
  onEvent: (event: AgentEventType) => void,
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
  const parseLine = createGeminiLineParser();

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
        onEvent({ type: "error", message: `Gemini CLI 进程异常退出 (code=${code})` });
      }
      session.messages.push({ role: "assistant", content: fullText || "(Gemini CLI completed)" });
      onEvent({ type: "done" });
      resolve();
    });

    proc.on("error", (err) => {
      console.error("[CLI] Failed to start Gemini CLI:", err.message);
      onEvent({
        type: "error",
        message: `无法启动 Gemini CLI: ${err.message}。请确认已安装: npm install -g @google/gemini-cli`,
      });
      onEvent({ type: "done" });
      resolve();
    });
  });
}

/** gemini stream-json 行解析器(工厂:内部维护合成 callId 计数)。 */
export function createGeminiLineParser(): (
  line: string,
  onEvent: (e: AgentEventType) => void,
  appendText: (t: string) => void
) => void {
  let synthCount = 0;
  return (line, onEvent, appendText) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let evt: GeminiStreamLine;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      return; // 非 JSON 行(ANSI 等)忽略
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
          onEvent({
            type: "tool-call",
            callId: evt.tool_id ?? `gm_${++synthCount}`,
            name: evt.tool_name,
            args: (evt.parameters as Record<string, unknown>) ?? {},
          });
        }
        break;
      case "tool_result":
        onEvent({
          type: "tool-result",
          callId: evt.tool_id ?? `gm_${synthCount}`,
          result: evt.output ?? {},
          ...(evt.status === "error" ? { isError: true } : {}),
        });
        break;
      case "result":
        if (evt.status === "error" && evt.error) {
          const errMsg = typeof evt.error === "string" ? evt.error : (evt.error.message ?? "Gemini CLI 执行失败");
          onEvent({ type: "error", message: errMsg });
        }
        break;
      case "error":
        onEvent({ type: "error", message: typeof evt.error === "string" ? evt.error : "Gemini CLI 未知错误" });
        break;
    }
  };
}
