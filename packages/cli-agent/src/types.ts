// ── CLI Agent 契约 ─────────────────────────────────────────
// 本库的归一化事件类型 CliEvent:字段名与 pocket-code wire 协议的对应
// 变体逐字相同(消费方可用编译期恒等函数映射,漂移即 tsc 报错)。
// 纯 TS 类型,零运行时依赖;运行时校验用 isCliEvent(./isCliEvent.js)。

/** CLI 适配层产出的归一化事件(7 变体判别联合)。 */
export type CliEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call"; callId: string; name: string; args: Record<string, unknown> }
  | { type: "tool-result"; callId: string; result: unknown; isError?: boolean }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "done" }
  | { type: "error"; message: string; code?: string };

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
   * 解析 CLI stdout 的一行 NDJSON,返回归一化 CliEvent 数组。
   * 对空行/非 JSON 行/无对应业务语义的类型,返回 []。
   * 无状态适配器实现本方法;有状态的实现 createParser。二者至少其一。
   */
  parseLine?(line: string): CliEvent[];
  /**
   * 可选:创建一次运行专用的解析器(每次 spawn 新建,状态互不串扰)。
   * runner 优先使用本方法。
   */
  createParser?(): (line: string) => CliEvent[];
  /** 可选:从 stdout 一行提取底层 CLI 的 session_id(claude stream-json init 消息)。首次命中即被 runner 记住。 */
  extractSessionId?(line: string): string | undefined;
}
