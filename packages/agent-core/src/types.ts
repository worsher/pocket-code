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

export type ModelDelta =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "usage"; inputTokens: number; outputTokens: number };

export interface ModelClient {
  /** 单步:流一轮 assistant 输出,浮出 tool calls 不执行。 */
  streamStep(req: {
    system: string;
    messages: CoreMessage[];
    tools: ToolSchema[];
    signal?: AbortSignal;
  }): AsyncIterable<ModelDelta>;
}

export interface ExecResult { stdout: string; stderr: string; exitCode: number }

export interface RuntimeBackend {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<{ isNew: boolean }>;
  /** 返回项含 dot 目录(resolveGitCwd 依赖 .git 可见)。 */
  listFiles(path: string): Promise<{ name: string; type: "file" | "dir" }[]>;
  /** 不抛非零:统一返回 exitCode。isolateHome=true 时 HOME 指向工作区等价目录。 */
  exec(cmd: string, opts?: { cwd?: string; timeoutMs?: number; env?: Record<string, string>; isolateHome?: boolean }): Promise<ExecResult>;
  startProcess?(cmd: string, opts?: { cwd?: string }): Promise<{ processId: string }>;
  stopProcess?(processId: string): Promise<void>;
}

export interface ToolSchema { name: string; description: string; parameters: Record<string, unknown> }  // JSON Schema 对象
export type { AgentEventType };
