# P3a CliAgentAdapter（claude-code 适配器 + 解析单测）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把当前 `cliRunner.ts` 里 claude-code 的 NDJSON 解析逻辑，重构成一个清晰的 `CliAgentAdapter` 接口 + `claudeCodeAdapter` 实现，其输出为 P2 定义的归一化 `AgentEvent`（来自 `@pocket-code/wire`），并配套完整的解析单元测试。

**Architecture:** 纯新增、不破坏现有运行时。新增 `packages/server/src/cli/`：`types.ts`（适配器接口）、`claudeCode.ts`（claude-code 适配器：`buildSpawn` 构造 spawn 参数 + `parseLine` 把一行 NDJSON 归一化为 `AgentEvent[]`）、`index.ts`（适配器注册表）、`claudeCode.test.ts`（解析与 spawn 构造的单测，并断言每个产出事件都能通过 wire 的 `AgentEvent.safeParse`）。**本计划不改 `cliRunner.ts`/`agent.ts`/`messageHandler.ts`**——用适配器替换现有 `runClaudeCodeAgent`、接入 AgentSession 透传与 App 消费，属 P3b。

**Tech Stack:** TypeScript、Zod（经 `@pocket-code/wire`）、vitest、Node child_process（仅在 `buildSpawn` 构造参数，本计划不真正 spawn）。

---

## 背景事实（执行者必读）

- 现有 `packages/server/src/cliRunner.ts` 的 `parseClaudeLine`（159-220 行）已对接真实 claude-code 的 `--output-format stream-json` NDJSON，是**可信的格式参考**。本计划保持其识别的消息形态，只把产出从旧 `StreamEvent` 重映射为归一化 `AgentEvent`，并补上 callId/usage/thinking。
- claude-code stream-json 关键消息形态（来自现有代码 + Anthropic 消息格式）：
  - `{ type: "system", subtype: "init", ... }` → 无业务事件。
  - `{ type: "assistant", message: { content: [ {type:"text", text}, {type:"thinking", thinking}, {type:"tool_use", id, name, input} ] } }`。
  - `{ type: "user", message: { content: [ {type:"tool_result", tool_use_id, content, is_error} ] } }`，`content` 可能是字符串或 `[{type:"text",text}]` 数组。
  - `{ type: "result", subtype: "success"|..., usage?: {input_tokens, output_tokens}, errors?: [...] }`。
  - `{ type: "stream_event", ... }`（--include-partial-messages 产生的细粒度增量）→ 本计划**忽略**（返回 `[]`），保持与现有"按完整 assistant 消息出 text"一致的 proven 行为；细粒度流式留作后续增强。
- P2 已让 server 依赖 `@pocket-code/wire` 并导出归一化 `AgentEvent`（schema）与 `AgentEventType`（类型），见 `packages/wire/src/agentEvent.ts`。server tsconfig `moduleResolution: bundler`，从 `@pocket-code/wire` 导入解析到其 `dist`（`pnpm build` 拓扑序先建 wire）。
- 归一化 `AgentEvent` 关键字段（须严格匹配，否则 `safeParse` 失败）：`tool-call` 用 `{callId, name, args}`；`tool-result` 用 `{callId, result, isError?}`；`error` 用 `{message, code?}`；`usage` 用 `{inputTokens, outputTokens}`（非负整数）；`reasoning-delta` 用 `{text}`。
- server 测试经 `vitest run src` 递归扫 `src/`，故 `src/cli/claudeCode.test.ts` 会被自动纳入；无需改任何 package.json。

## 文件结构（本计划涉及）

- 新建：`packages/server/src/cli/types.ts`（`CliAgentAdapter` 接口）
- 新建：`packages/server/src/cli/claudeCode.ts`（`claudeCodeAdapter`）
- 新建：`packages/server/src/cli/index.ts`（注册表）
- 新建：`packages/server/src/cli/claudeCode.test.ts`（单测）

> 所有命令均在仓库根目录 `/Users/worsher/code/self/pocket-code` 执行。

---

### Task 1: 定义 CliAgentAdapter 接口

**Files:**
- Create: `packages/server/src/cli/types.ts`

- [ ] **Step 1: 创建接口文件**

创建 `packages/server/src/cli/types.ts`，内容：

```typescript
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
   */
  parseLine(line: string): AgentEventType[];
}
```

- [ ] **Step 2: 验证类型可编译**

Run: `pnpm --filter @pocket-code/wire build && pnpm --filter @pocket-code/server exec tsc --noEmit`
Expected: 无报错（wire 先构建以提供 `AgentEventType` 类型；server 仅类型检查，types.ts 通过）。

- [ ] **Step 3: 提交**

```bash
git add packages/server/src/cli/types.ts
git commit -m "feat(server): 定义 CliAgentAdapter 接口"
```

---

### Task 2: 实现 claude-code 适配器（TDD）

**Files:**
- Create: `packages/server/src/cli/claudeCode.test.ts`（先写，失败）
- Create: `packages/server/src/cli/claudeCode.ts`（实现，转绿）
- Create: `packages/server/src/cli/index.ts`（注册表）

- [ ] **Step 1: 先写失败测试**

创建 `packages/server/src/cli/claudeCode.test.ts`，内容：

```typescript
import { describe, it, expect } from "vitest";
import { AgentEvent } from "@pocket-code/wire";
import { claudeCodeAdapter } from "./claudeCode.js";

const line = (obj: unknown) => JSON.stringify(obj);

describe("claudeCodeAdapter.parseLine", () => {
  it("returns [] for blank / non-JSON / system lines", () => {
    expect(claudeCodeAdapter.parseLine("")).toEqual([]);
    expect(claudeCodeAdapter.parseLine("   ")).toEqual([]);
    expect(claudeCodeAdapter.parseLine("not json")).toEqual([]);
    expect(
      claudeCodeAdapter.parseLine(line({ type: "system", subtype: "init", model: "claude" }))
    ).toEqual([]);
    expect(claudeCodeAdapter.parseLine(line({ type: "stream_event", event: {} }))).toEqual([]);
  });

  it("maps assistant text block to text-delta", () => {
    const evs = claudeCodeAdapter.parseLine(
      line({ type: "assistant", message: { content: [{ type: "text", text: "hello" }] } })
    );
    expect(evs).toEqual([{ type: "text-delta", text: "hello" }]);
  });

  it("maps assistant thinking block to reasoning-delta", () => {
    const evs = claudeCodeAdapter.parseLine(
      line({ type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm" }] } })
    );
    expect(evs).toEqual([{ type: "reasoning-delta", text: "hmm" }]);
  });

  it("maps tool_use to tool-call with callId/name/args", () => {
    const evs = claudeCodeAdapter.parseLine(
      line({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "tu_1", name: "runCommand", input: { command: "ls" } }],
        },
      })
    );
    expect(evs).toEqual([
      { type: "tool-call", callId: "tu_1", name: "runCommand", args: { command: "ls" } },
    ]);
  });

  it("emits multiple events for a multi-block assistant message", () => {
    const evs = claudeCodeAdapter.parseLine(
      line({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "a" },
            { type: "tool_use", id: "tu_2", name: "readFile", input: { path: "x" } },
          ],
        },
      })
    );
    expect(evs).toHaveLength(2);
    expect(evs[0]).toEqual({ type: "text-delta", text: "a" });
    expect(evs[1]).toMatchObject({ type: "tool-call", callId: "tu_2", name: "readFile" });
  });

  it("maps tool_result (array content) to tool-result with tool_use_id as callId", () => {
    const evs = claudeCodeAdapter.parseLine(
      line({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: "ok" }] },
          ],
        },
      })
    );
    expect(evs).toEqual([{ type: "tool-result", callId: "tu_1", result: "ok", isError: false }]);
  });

  it("maps tool_result with is_error=true and string content", () => {
    const evs = claudeCodeAdapter.parseLine(
      line({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tu_9", content: "boom", is_error: true }],
        },
      })
    );
    expect(evs).toEqual([{ type: "tool-result", callId: "tu_9", result: "boom", isError: true }]);
  });

  it("maps result success with usage to a usage event", () => {
    const evs = claudeCodeAdapter.parseLine(
      line({ type: "result", subtype: "success", usage: { input_tokens: 12, output_tokens: 34 } })
    );
    expect(evs).toEqual([{ type: "usage", inputTokens: 12, outputTokens: 34 }]);
  });

  it("maps result error subtype to an error event", () => {
    const evs = claudeCodeAdapter.parseLine(
      line({ type: "result", subtype: "error_max_turns", errors: ["too many turns"] })
    );
    expect(evs).toHaveLength(1);
    expect(evs[0].type).toBe("error");
    if (evs[0].type === "error") expect(evs[0].message).toContain("too many turns");
  });

  it("every emitted event validates against the wire AgentEvent schema", () => {
    const samples = [
      line({ type: "assistant", message: { content: [{ type: "text", text: "x" }] } }),
      line({ type: "assistant", message: { content: [{ type: "thinking", thinking: "t" }] } }),
      line({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "i", name: "n", input: {} }] },
      }),
      line({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "i", content: "r" }] },
      }),
      line({ type: "result", subtype: "success", usage: { input_tokens: 1, output_tokens: 2 } }),
      line({ type: "result", subtype: "error_x", errors: ["e"] }),
    ];
    for (const s of samples) {
      for (const ev of claudeCodeAdapter.parseLine(s)) {
        expect(AgentEvent.safeParse(ev).success).toBe(true);
      }
    }
  });
});

describe("claudeCodeAdapter.buildSpawn", () => {
  it("builds claude spawn spec with stream-json and workspace cwd", () => {
    const spec = claudeCodeAdapter.buildSpawn("do a thing", { workspace: "/ws/proj" });
    expect(spec.cmd).toBe(process.env.CLAUDE_CLI_PATH || "claude");
    expect(spec.cwd).toBe("/ws/proj");
    expect(spec.args).toContain("-p");
    expect(spec.args).toContain("do a thing");
    expect(spec.args).toContain("--output-format");
    expect(spec.args).toContain("stream-json");
    expect(spec.args).not.toContain("--append-system-prompt");
  });

  it("strips ANTHROPIC API key env vars (claude CLI uses its own OAuth)", () => {
    const spec = claudeCodeAdapter.buildSpawn("x", { workspace: "/ws" });
    expect(spec.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(spec.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("appends project system prompt when customPrompt is provided", () => {
    const spec = claudeCodeAdapter.buildSpawn("x", { workspace: "/ws", customPrompt: "use tabs" });
    const i = spec.args.indexOf("--append-system-prompt");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(spec.args[i + 1]).toContain("use tabs");
  });

  it("declares id and resume support", () => {
    expect(claudeCodeAdapter.id).toBe("claude-code");
    expect(claudeCodeAdapter.supportsResume).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试，确认因缺实现而失败**

Run: `pnpm --filter @pocket-code/wire build && pnpm --filter @pocket-code/server test`
Expected: FAIL —— 报无法解析 `./claudeCode.js`（实现尚未创建）。

- [ ] **Step 3: 实现 claude-code 适配器**

创建 `packages/server/src/cli/claudeCode.ts`，内容：

```typescript
// ── claude-code 适配器 ─────────────────────────────────────
// 把 claude CLI 的 --output-format stream-json NDJSON 归一化为 AgentEvent。
// 解析形态参考既有 cliRunner.ts 的 parseClaudeLine(proven 对接真实 claude-code)。

import type { AgentEventType } from "@pocket-code/wire";
import type { CliAgentAdapter, CliSpawnContext, CliSpawnSpec } from "./types.js";

/** 安全转为非负整数,无效值归零。 */
function toCount(v: unknown): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** tool_result.content 可能是字符串或 [{type:"text",text}] 数组,统一取文本。 */
function toolResultText(content: unknown): string {
  if (Array.isArray(content)) {
    return content.map((c: any) => (c?.type === "text" ? String(c.text ?? "") : "")).join("");
  }
  return String(content ?? "");
}

export const claudeCodeAdapter: CliAgentAdapter = {
  id: "claude-code",
  supportsResume: true,

  buildSpawn(userMessage: string, ctx: CliSpawnContext): CliSpawnSpec {
    const args = [
      "-p", userMessage,
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--dangerously-skip-permissions",
    ];
    if (ctx.customPrompt?.trim()) {
      args.push(
        "--append-system-prompt",
        `\n\n## Project Instructions\n${ctx.customPrompt.trim()}`
      );
    }
    // claude CLI 使用自身存储的 OAuth 凭证;清除 API key 避免干扰其认证。
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    return {
      cmd: process.env.CLAUDE_CLI_PATH || "claude",
      args,
      env,
      cwd: ctx.workspace,
    };
  },

  parseLine(line: string): AgentEventType[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let msg: any;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return [];
    }

    const events: AgentEventType[] = [];
    switch (msg?.type) {
      case "assistant": {
        const content = msg.message?.content;
        if (!Array.isArray(content)) break;
        for (const block of content) {
          if (block?.type === "text" && typeof block.text === "string") {
            events.push({ type: "text-delta", text: block.text });
          } else if (block?.type === "thinking" && typeof block.thinking === "string") {
            events.push({ type: "reasoning-delta", text: block.thinking });
          } else if (block?.type === "tool_use") {
            events.push({
              type: "tool-call",
              callId: typeof block.id === "string" ? block.id : "",
              name: typeof block.name === "string" ? block.name : "",
              args: block.input && typeof block.input === "object" ? block.input : {},
            });
          }
        }
        break;
      }
      case "user": {
        const content = msg.message?.content;
        if (!Array.isArray(content)) break;
        for (const block of content) {
          if (block?.type === "tool_result") {
            events.push({
              type: "tool-result",
              callId: typeof block.tool_use_id === "string" ? block.tool_use_id : "",
              result: toolResultText(block.content),
              isError: block.is_error === true,
            });
          }
        }
        break;
      }
      case "result": {
        if (msg.subtype && msg.subtype !== "success") {
          const errMsg = Array.isArray(msg.errors)
            ? msg.errors.join(", ")
            : String(msg.subtype);
          events.push({ type: "error", message: `Claude Code 执行失败: ${errMsg}` });
        } else if (msg.usage && typeof msg.usage === "object") {
          events.push({
            type: "usage",
            inputTokens: toCount(msg.usage.input_tokens),
            outputTokens: toCount(msg.usage.output_tokens),
          });
        }
        break;
      }
      // "system" / "stream_event" / 其它 → 无业务事件
    }
    return events;
  },
};
```

- [ ] **Step 4: 创建适配器注册表**

创建 `packages/server/src/cli/index.ts`，内容：

```typescript
// ── CLI 适配器注册表 ───────────────────────────────────────
import type { CliAgentAdapter } from "./types.js";
import { claudeCodeAdapter } from "./claudeCode.js";

export type { CliAgentAdapter, CliSpawnContext, CliSpawnSpec } from "./types.js";
export { claudeCodeAdapter } from "./claudeCode.js";

/** 按 id 索引的可用适配器。P3a 仅 claude-code;codex/gemini-cli 后续接入。 */
export const cliAdapters: Record<string, CliAgentAdapter> = {
  [claudeCodeAdapter.id]: claudeCodeAdapter,
};
```

- [ ] **Step 5: 运行测试，确认全绿**

Run: `pnpm --filter @pocket-code/wire build && pnpm --filter @pocket-code/server test`
Expected: PASS —— 新增 `src/cli/claudeCode.test.ts` 全过（含 buildSpawn 与 parseLine 共约 14 个用例），server 其余测试不受影响。

- [ ] **Step 6: 全链路验证（与 CI 一致）**

Run: `pnpm build && pnpm test:all && pnpm typecheck:app && echo ALL GREEN`
Expected: 末尾打印 `ALL GREEN`。

- [ ] **Step 7: 提交**

```bash
git add packages/server/src/cli/claudeCode.ts packages/server/src/cli/claudeCode.test.ts packages/server/src/cli/index.ts
git commit -m "feat(server): claude-code 适配器(buildSpawn + parseLine→AgentEvent)含单测"
```

---

## Self-Review

**1. Spec coverage（对照 spec 第 3.4 节）：**
- ✅ `CliAgentAdapter` 接口（id / supportsResume / buildSpawn / parseLine）→ Task 1
- ✅ claude-code 适配器：复用现有 proven 解析形态，输出归一化 AgentEvent，补 callId/usage/thinking → Task 2
- ✅ 解析单测 + "产出事件均通过 wire AgentEvent.safeParse" 强校验 → Task 2 Step 1
- 注：用适配器替换 `runClaudeCodeAgent`、接 AgentSession 透传、App 消费、daemon/relay 边界校验 = **P3b**，不在本计划。codex/gemini-cli 适配器后续。

**2. Placeholder scan：** 无 TBD/TODO；每个步骤含完整文件内容与精确命令、预期输出。

**3. Type consistency：** 适配器 `parseLine` 产出严格匹配 wire `AgentEvent` 字段（`tool-call`={callId,name,args}、`tool-result`={callId,result,isError}、`error`={message}、`usage`={inputTokens,outputTokens}、`reasoning-delta`={text}）；测试用例的断言与实现产出一致；`index.ts` 导出名与 `types.ts`/`claudeCode.ts` 一致。

**4. 风险：** 真实 claude-code stream-json 字段若与假设有出入（如 thinking 块字段名、usage 字段名），单测仍会绿（用合成行），但真机对接时(P3b)需用真实输出校准——这是 P3a 选择"保持既有 proven 解析形态、只补充字段"的原因，把偏差面降到最小。
