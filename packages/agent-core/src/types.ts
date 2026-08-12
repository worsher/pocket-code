import type { AgentEventType } from "@pocket-code/wire";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; base64: string; mimeType: string };

export type CoreMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string; toolCalls?: ToolCallReq[] }
  | { role: "tool"; toolCallId: string; toolName: string; content: string };

export interface ToolCallReq { id: string; name: string; args: Record<string, unknown> }

/** runAgentLoop 的四值结束原因(spec 2026-07-21 C12-1)。 */
export type LoopStopReason = "end_turn" | "max_steps" | "aborted" | "error";

/** runAgentLoop 的结构化返回值:任何输入下不抛,错误收敛为 stopReason(spec D1)。 */
export interface RunAgentResult {
  messages: CoreMessage[];
  fullText: string;
  stopReason: LoopStopReason;
  usage: { inputTokens: number; outputTokens: number };
  /** 实际启动的 step 数(含出错/中断的那一步)。 */
  steps: number;
  /** 仅 stopReason === "error" 时存在,非空。 */
  errorMessage?: string;
}

export type ModelDelta =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "usage"; inputTokens: number; outputTokens: number };

/** streamStep 失败的四分类(spec 2026-07-21 §4.1):
 *  retryable(429/5xx/网络抖动→指数退避)、too-large(413→媒体降级)、
 *  media-rejected(图片格式/内容被拒→全剥离)、fatal(其余,不重试)。 */
export type ModelErrorKind = "retryable" | "too-large" | "media-rejected" | "fatal";

export interface ModelClient {
  /** 单步:流一轮 assistant 输出,浮出 tool calls 不执行。 */
  streamStep(req: {
    system: string;
    messages: CoreMessage[];
    tools: ToolSchema[];
    signal?: AbortSignal;
  }): AsyncIterable<ModelDelta>;
  /** 错误分类;缺省时一切错误按 "fatal" 处理(现状行为)。 */
  classifyError?(error: unknown): ModelErrorKind;
  /** 服务端 Retry-After(ms);存在且为正时优先于本地退避。 */
  retryAfterMs?(error: unknown): number | undefined;
}

export interface ExecResult { stdout: string; stderr: string; exitCode: number }

export type CredentialAwareGitTool = "gitClone" | "gitPull" | "gitPush";

export interface RuntimeBackend {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<{ isNew: boolean }>;
  /** 返回项含 dot 目录(resolveGitCwd 依赖 .git 可见)。 */
  listFiles(path: string): Promise<{ name: string; type: "file" | "dir" }[]>;
  /** 不抛非零:统一返回 exitCode。isolateHome=true 时 HOME 指向工作区等价目录。 */
  exec(cmd: string, opts?: { cwd?: string; timeoutMs?: number; env?: Record<string, string>; isolateHome?: boolean }): Promise<ExecResult>;
  /**
   * 远程 Git 的受控凭据通道。实现方从项目绑定的 profile 解析 secret，
   * 但只返回脱敏的操作结果；模型和 core 永远拿不到 secret。
   */
  runCredentialAwareGit?(
    tool: CredentialAwareGitTool,
    args: Record<string, unknown>
  ): Promise<unknown>;
  startProcess?(cmd: string, opts?: { cwd?: string }): Promise<{ processId: string }>;
  stopProcess?(processId: string): Promise<void>;
}

export interface ToolSchema { name: string; description: string; parameters: Record<string, unknown> }  // JSON Schema 对象
export type { AgentEventType };
