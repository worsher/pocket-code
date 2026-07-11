// ── CliAgentAdapter ───────────────────────────────────────
// 统一封装外部 CLI 编程代理(claude-code / codex / gemini-cli)的接口。
// 适配器只负责:① 构造子进程 spawn 参数;② 把 CLI 的 NDJSON 输出逐行
// 归一化为 @pocket-code/wire 的 AgentEvent。进程生命周期/transport 由
// 上层(P3b 的 DelegatedCliAgent 运行器)负责,与适配器解耦。

import type { AgentEventType } from "@pocket-code/wire";

/** 一次用户轮次的 spawn 上下文。 */
export interface CliSpawnContext {
  /** 代理执行的工作目录(workspace 绝对路径)。 */
  workspace: string;
  /** 可选的项目级系统指令(注入 CLI)。 */
  customPrompt?: string;
  /** claude 续接:上轮捕获的 session_id(有则 buildSpawn 加 --resume)。 */
  resumeSessionId?: string;
}

/** 子进程 spawn 规格(由上层运行器据此 spawn)。 */
export interface CliSpawnSpec {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export interface CliAgentAdapter {
  /** 稳定标识。 */
  readonly id: "claude-code" | "codex" | "gemini-cli";
  /** 底层 CLI 是否支持续接上一次会话。 */
  readonly supportsResume: boolean;
  /** 据用户消息与上下文构造 spawn 规格。 */
  buildSpawn(userMessage: string, ctx: CliSpawnContext): CliSpawnSpec;
  /**
   * 解析 CLI stdout 的一行 NDJSON,返回归一化 AgentEvent 数组。
   * 对空行/非 JSON 行/无对应业务语义的类型,返回 []。
   * 无状态适配器实现本方法;有状态的实现 createParser。二者至少其一。
   */
  parseLine?(line: string): AgentEventType[];
  /**
   * 可选:创建一次运行专用的解析器(每次 spawn 新建,状态互不串扰)。
   * runner 优先使用本方法。
   */
  createParser?(): (line: string) => AgentEventType[];
  /** 可选:从 stdout 一行提取底层 CLI 的 session_id(claude stream-json init 消息)。首次命中即被 runner 记住。 */
  extractSessionId?(line: string): string | undefined;
}
