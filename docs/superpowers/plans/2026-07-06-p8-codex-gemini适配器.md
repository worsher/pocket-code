# P8 codex / gemini-cli 适配器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** codex、gemini-cli 接入 CliAgentAdapter 注册表，agent 路由改注册表查找，删除 cliRunner.ts。

**Architecture:** 五个任务：① 接口演进（`createParser()` 可选工厂）+ runner 适配；② geminiAdapter（spawn/解析等价迁移）；③ codexAdapter（按真机 fixture 写解析）；④ agent.ts 注册表路由 + `runCliSession` 通用包装 + 删 cliRunner；⑤ App 模型入口 + E2E 守卫 + 全仓验证。

**Tech Stack:** TypeScript、`@pocket-code/wire` AgentEvent、Node child_process（可注入 spawn 的 fake 测试模式）、vitest。

## Global Constraints

- claude-code 路径行为零变化（纯路由重构，现有 claudeCode 测试不改）。
- codex spawn：`exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox`；**env 不清理**（尊重用户 config.toml）。
- gemini 迁移与旧路径唯一有意差异：customPrompt 非空时拼接为消息前缀 `## Project Instructions\n<cp>\n\n<msg>`（旧路径丢弃）；codex 同策略。
- `supportsResume` 均 false。
- 完成后 `grep -r "cliRunner" packages/` 零命中。
- 各包测试 `vitest run src`；提交信息中文 `feat/fix/refactor/test(scope):` 前缀。
- 工作分支 `feature/p8-cli-adapters`（已创建）。

## 背景事实（执行者必读）

- 仓库根 `/Users/wangfeiran/github/pocket-code`。
- `CliAgentAdapter`（`cli/types.ts`）现接口：`id`（union 已含 "codex"|"gemini-cli"）、`supportsResume`、`buildSpawn(userMessage, ctx)`、`parseLine(line)`。runner（`cli/runner.ts:100`）逐行调 `adapter.parseLine(line)`。
- **真机 fixture（2026-07-06，codex-cli 0.142.5 官方通道实测）**：
  ```
  {"type":"thread.started","thread_id":"019f3661-..."}
  {"type":"turn.started"}
  {"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"/bin/zsh -lc \"sed -n ...\"","aggregated_output":"","exit_code":null,"status":"in_progress"}}
  {"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"...","aggregated_output":"sed: ...: No such file or directory\n","exit_code":1,"status":"failed"}}
  {"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Hi there friend"}}
  {"type":"turn.completed","usage":{"input_tokens":33890,"cached_input_tokens":21760,"output_tokens":268,"reasoning_output_tokens":166}}
  {"type":"error","message":"stream error: ...; retrying 1/5 in 208ms…"}
  {"type":"turn.failed","error":{"message":"exceeded retry limit, last status: 401 Unauthorized, ..."}}
  ```
  `file_change`/`mcp_tool_call`/`reasoning` 未实测触发，按 codex-rs JSONL schema：`file_change.changes: [{path, kind: "add"|"update"|"delete"}]`；`mcp_tool_call: {id, server, tool, status}`；`reasoning: {id, text}`。
- gemini 现实现：`cliRunner.ts` 的 `runGeminiCliAgent`（spawn 参数/env 清理，77-175 行）与 `createGeminiLineParser`（178-241 行，P6b 已产 AgentEvent）；解析测试在 `cliRunner.gemini.test.ts`（5 用例）。
- `agent.ts:160-171` 两个 if 硬编码路由（本计划替换）；`MODELS` 表在 `agent.ts:30-48` 附近（含 claude-code/gemini-cli 条目）。
- runner 的 fake 进程测试模式（`runner.test.ts:8-18`）：`makeFakeProc()` 提供 `pushLine/finish`，`runCliAgent(..., spawnFn)` 注入。
- E2E 守卫模式（`claudeCode.e2e.test.ts:11-22`）：`RUN_CLI_E2E` env + `command -v <cli>` 双守卫 + `describe.skipIf`。
- App 模型条目形状（`modelConfig.ts:108-125`）：`{ key, label, description, provider, modelId, baseURL: "", cloudOnly: true }`。

## 文件结构

- 修改：`packages/server/src/cli/types.ts`（parseLine 可选 + createParser 可选）、`packages/server/src/cli/runner.ts`（解析器选择）、`packages/server/src/cli/runner.test.ts`（createParser 用例）
- 新建：`packages/server/src/cli/gemini.ts` + `gemini.test.ts`、`packages/server/src/cli/codex.ts` + `codex.test.ts`、`codex.e2e.test.ts`、`gemini.e2e.test.ts`
- 修改：`packages/server/src/cli/index.ts`（注册表 + `runCliSession`）+ 新建 `packages/server/src/cli/session.test.ts`
- 修改：`packages/server/src/agent.ts`（注册表路由 + MODELS 加 codex）
- 删除：`packages/server/src/cliRunner.ts`、`packages/server/src/cliRunner.gemini.test.ts`
- 修改：`packages/app/src/services/modelConfig.ts`（codex 条目）

> 命令均在仓库根执行。

---

### Task 1: 接口演进（createParser）+ runner 适配

**Files:**
- Modify: `packages/server/src/cli/types.ts`、`packages/server/src/cli/runner.ts`
- Modify: `packages/server/src/cli/runner.test.ts`（追加用例）

**Interfaces:**
- Produces: `CliAgentAdapter.parseLine?`（变可选）、`CliAgentAdapter.createParser?(): (line: string) => AgentEventType[]`；runner 规则=**优先 createParser（每次运行新建实例），否则 parseLine，两者皆无则抛错**。Task 2 的 gemini 用 createParser，Task 3 的 codex 用 parseLine，claude 不动。

- [ ] **Step 1: 写失败测试**。`packages/server/src/cli/runner.test.ts` 追加：

```ts
describe("runCliAgent parser selection", () => {
  it("prefers createParser and creates a fresh parser per run (stateful adapters)", async () => {
    // 有状态适配器:每行输出一个递增序号事件;两次运行序号都应从 1 开始
    const statefulAdapter = {
      id: "gemini-cli" as const,
      supportsResume: false,
      buildSpawn: () => ({ cmd: "x", args: [], env: {}, cwd: "/" }),
      createParser: () => {
        let n = 0;
        return (_line: string) => [{ type: "text-delta" as const, text: `#${++n}` }];
      },
    };
    for (const run of [1, 2]) {
      const proc = makeFakeProc();
      const events: any[] = [];
      const p = runCliAgent(statefulAdapter as any, "hi", ctx, (e) => events.push(e), undefined, () => proc);
      proc.pushLine({ a: 1 });
      proc.pushLine({ a: 2 });
      proc.finish(0);
      await p;
      expect(events.filter((e) => e.type === "text-delta").map((e) => e.text)).toEqual(["#1", "#2"]);
    }
  });

  it("throws a clear error when adapter has neither parseLine nor createParser", async () => {
    const badAdapter = {
      id: "codex" as const,
      supportsResume: false,
      buildSpawn: () => ({ cmd: "x", args: [], env: {}, cwd: "/" }),
    };
    await expect(
      runCliAgent(badAdapter as any, "hi", ctx, () => {}, undefined, () => makeFakeProc())
    ).rejects.toThrow(/parseLine|createParser/);
  });
});
```

- [ ] **Step 2: 确认失败**

Run: `pnpm --filter @pocket-code/server test src/cli/runner.test.ts`
Expected: FAIL（createParser 未被支持 / 无解析器时行为不符）

- [ ] **Step 3: 实现**。`cli/types.ts` 的接口尾部改为：

```ts
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
```

`cli/runner.ts`：在取得 `spec` 之后（`adapter.buildSpawn` 调用附近）加：

```ts
  const parse =
    adapter.createParser?.() ??
    (adapter.parseLine ? adapter.parseLine.bind(adapter) : undefined);
  if (!parse) {
    throw new Error(`adapter ${adapter.id} must implement parseLine or createParser`);
  }
```

原 L100 `for (const ev of adapter.parseLine(line)) handle(ev);` 改为 `for (const ev of parse(line)) handle(ev);`。

注意 runner 的返回是 Promise：`throw` 需发生在 Promise 语义内（`runCliAgent` 是 async 函数则直接 throw 即可；若为显式 new Promise 结构，把检查放在函数体最前、Promise 构造之前，直接 `throw`——async 函数外壳会把它变成 rejection）。以现有函数结构为准。

- [ ] **Step 4: 确认通过（含既有用例不回归）**

Run: `pnpm --filter @pocket-code/server test src/cli/`
Expected: 全 PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/cli/types.ts packages/server/src/cli/runner.ts packages/server/src/cli/runner.test.ts
git commit -m "feat(server): CliAgentAdapter 支持 createParser(有状态解析器,每次运行独立)"
```

---

### Task 2: geminiAdapter（等价迁移）

**Files:**
- Create: `packages/server/src/cli/gemini.ts`、`packages/server/src/cli/gemini.test.ts`
- Modify: `packages/server/src/cli/index.ts`（注册）

**Interfaces:**
- Consumes: Task 1 的 `createParser` 接口。
- Produces: `geminiAdapter: CliAgentAdapter`（id "gemini-cli"）。**本任务不动 cliRunner.ts**（与 gemini.ts 短暂双份，Task 4 删除）。

- [ ] **Step 1: 写失败测试** `packages/server/src/cli/gemini.test.ts`（解析用例迁自 `cliRunner.gemini.test.ts`，驱动方式改为 `geminiAdapter.createParser()`）：

```ts
import { describe, it, expect } from "vitest";
import { AgentEvent, type AgentEventType } from "@pocket-code/wire";
import { geminiAdapter } from "./gemini.js";

function collect(lines: string[]): AgentEventType[] {
  const parse = geminiAdapter.createParser!();
  const events: AgentEventType[] = [];
  for (const l of lines) events.push(...parse(l));
  return events;
}

describe("geminiAdapter.createParser", () => {
  it("maps assistant message to text-delta", () => {
    const events = collect([JSON.stringify({ type: "message", role: "assistant", content: "hello" })]);
    expect(events).toEqual([{ type: "text-delta", text: "hello" }]);
  });

  it("maps tool_use/tool_result with native tool_id as callId", () => {
    const events = collect([
      JSON.stringify({ type: "tool_use", tool_name: "read_file", tool_id: "t1", parameters: { path: "a" } }),
      JSON.stringify({ type: "tool_result", tool_id: "t1", status: "success", output: { ok: true } }),
    ]);
    expect(events[0]).toEqual({ type: "tool-call", callId: "t1", name: "read_file", args: { path: "a" } });
    expect(events[1]).toEqual({ type: "tool-result", callId: "t1", result: { ok: true } });
  });

  it("synthesizes callId when tool_id missing and flags error results", () => {
    const events = collect([
      JSON.stringify({ type: "tool_use", tool_name: "x", parameters: {} }),
      JSON.stringify({ type: "tool_result", status: "error", output: "boom" }),
    ]);
    expect((events[0] as any).callId).toMatch(/^gm_/);
    expect((events[1] as any).isError).toBe(true);
  });

  it("maps result/error lines to error events; ignores junk; parser state is per-instance", () => {
    const events = collect([
      "not json",
      JSON.stringify({ type: "result", status: "error", error: { message: "failed" } }),
      JSON.stringify({ type: "error", error: "bad" }),
    ]);
    expect(events).toEqual([
      { type: "error", message: "failed" },
      { type: "error", message: "bad" },
    ]);
    // 新实例计数重置
    const again = collect([JSON.stringify({ type: "tool_use", tool_name: "y", parameters: {} })]);
    expect((again[0] as any).callId).toBe("gm_1");
  });

  it("all produced events pass wire AgentEvent.safeParse", () => {
    const events = collect([
      JSON.stringify({ type: "message", role: "assistant", content: "a" }),
      JSON.stringify({ type: "tool_use", tool_name: "n", tool_id: "t", parameters: {} }),
      JSON.stringify({ type: "tool_result", tool_id: "t", status: "success", output: {} }),
    ]);
    for (const ev of events) expect(AgentEvent.safeParse(ev).success).toBe(true);
  });
});

describe("geminiAdapter.buildSpawn", () => {
  it("builds gemini exec args with stream-json/yolo/extensions and cleans GCP env", () => {
    const prevModel = process.env.GEMINI_CLI_MODEL;
    delete process.env.GEMINI_CLI_MODEL;
    const spec = geminiAdapter.buildSpawn("do it", { workspace: "/ws" });
    expect(spec.cmd).toBe(process.env.GEMINI_CLI_PATH || "gemini");
    expect(spec.args).toEqual([
      "--prompt", "do it",
      "--output-format", "stream-json",
      "--yolo",
      "--extensions", "__none__",
    ]);
    expect(spec.cwd).toBe("/ws");
    expect(spec.env.GOOGLE_CLOUD_PROJECT).toBeUndefined();
    expect(spec.env.GCLOUD_PROJECT).toBeUndefined();
    if (prevModel !== undefined) process.env.GEMINI_CLI_MODEL = prevModel;
  });

  it("prefixes customPrompt into the message (旧路径丢弃,有意差异)", () => {
    const spec = geminiAdapter.buildSpawn("msg", { workspace: "/ws", customPrompt: "rules" });
    expect(spec.args[1]).toBe("## Project Instructions\nrules\n\nmsg");
  });

  it("respects GEMINI_CLI_MODEL", () => {
    process.env.GEMINI_CLI_MODEL = "gemini-test";
    const spec = geminiAdapter.buildSpawn("m", { workspace: "/ws" });
    expect(spec.args).toContain("--model");
    expect(spec.args).toContain("gemini-test");
    delete process.env.GEMINI_CLI_MODEL;
  });
});
```

- [ ] **Step 2: 确认失败**

Run: `pnpm --filter @pocket-code/server test src/cli/gemini.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现** `packages/server/src/cli/gemini.ts`（spawn/解析逻辑自 `cliRunner.ts` 等价迁移，注意 args 顺序与测试一致）：

```ts
// ── gemini-cli 适配器 ───────────────────────────────────────
// spawn 参数与 stream-json 解析等价迁移自 cliRunner.ts(P8 后删除)。
// 与旧路径唯一有意差异:customPrompt 非空时拼为消息前缀(旧路径丢弃)。

import type { AgentEventType } from "@pocket-code/wire";
import type { CliAgentAdapter, CliSpawnContext, CliSpawnSpec } from "./types.js";

/** gemini stream-json 行结构(NDJSON) */
interface GeminiStreamLine {
  type: "init" | "message" | "tool_use" | "tool_result" | "result" | "error";
  session_id?: string;
  model?: string;
  role?: "user" | "assistant";
  content?: string;
  tool_name?: string;
  tool_id?: string;
  parameters?: unknown;
  status?: "success" | "error";
  output?: unknown;
  error?: { type?: string; message?: string } | string;
}

export const geminiAdapter: CliAgentAdapter = {
  id: "gemini-cli",
  supportsResume: false,

  buildSpawn(userMessage: string, ctx: CliSpawnContext): CliSpawnSpec {
    const message = ctx.customPrompt?.trim()
      ? `## Project Instructions\n${ctx.customPrompt.trim()}\n\n${userMessage}`
      : userMessage;

    const args = [
      "--prompt", message,
      "--output-format", "stream-json",
      "--yolo",
    ];
    const geminiModel = process.env.GEMINI_CLI_MODEL;
    if (geminiModel) args.push("--model", geminiModel);
    // 默认不加载用户全局扩展,避免 chrome-devtools 等挂起;
    // 传不存在的名称 = 跳过所有扩展加载。
    const extensions = process.env.GEMINI_CLI_EXTENSIONS?.split(",").filter(Boolean) ?? [];
    args.push("--extensions", ...(extensions.length > 0 ? extensions : ["__none__"]));

    // 清除 GCP 项目变量,避免干扰 gemini CLI 的项目选择
    const env = { ...process.env };
    delete env.GOOGLE_CLOUD_PROJECT;
    delete env.GCLOUD_PROJECT;

    return {
      cmd: process.env.GEMINI_CLI_PATH || "gemini",
      args,
      env,
      cwd: ctx.workspace,
    };
  },

  createParser(): (line: string) => AgentEventType[] {
    let synthCount = 0;
    return (line: string): AgentEventType[] => {
      const trimmed = line.trim();
      if (!trimmed) return [];
      let evt: GeminiStreamLine;
      try {
        evt = JSON.parse(trimmed);
      } catch {
        return []; // 非 JSON 行(ANSI 等)忽略
      }
      switch (evt.type) {
        case "init":
          console.log(`[CLI] Gemini session=${evt.session_id}, model=${evt.model}`);
          return [];
        case "message":
          return evt.role === "assistant" && evt.content
            ? [{ type: "text-delta", text: evt.content }]
            : [];
        case "tool_use":
          return evt.tool_name
            ? [{
                type: "tool-call",
                callId: evt.tool_id ?? `gm_${++synthCount}`,
                name: evt.tool_name,
                args: (evt.parameters as Record<string, unknown>) ?? {},
              }]
            : [];
        case "tool_result":
          return [{
            type: "tool-result",
            callId: evt.tool_id ?? `gm_${synthCount}`,
            result: evt.output ?? {},
            ...(evt.status === "error" ? { isError: true } : {}),
          }];
        case "result":
          if (evt.status === "error" && evt.error) {
            const msg = typeof evt.error === "string" ? evt.error : (evt.error.message ?? "Gemini CLI 执行失败");
            return [{ type: "error", message: msg }];
          }
          return [];
        case "error":
          return [{
            type: "error",
            message: typeof evt.error === "string" ? evt.error : "Gemini CLI 未知错误",
          }];
        default:
          return [];
      }
    };
  },
};
```

`cli/index.ts` 注册（import + 注册表 + re-export）：

```ts
import { geminiAdapter } from "./gemini.js";
export { geminiAdapter } from "./gemini.js";
// cliAdapters 增加:
  [geminiAdapter.id]: geminiAdapter,
```

- [ ] **Step 4: 确认通过**

Run: `pnpm --filter @pocket-code/server test src/cli/`
Expected: 全 PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/cli/gemini.ts packages/server/src/cli/gemini.test.ts packages/server/src/cli/index.ts
git commit -m "feat(server): geminiAdapter(spawn/解析等价迁移+customPrompt 前缀拼接)"
```

---

### Task 3: codexAdapter（真机 fixture 驱动）

**Files:**
- Create: `packages/server/src/cli/codex.ts`、`packages/server/src/cli/codex.test.ts`
- Modify: `packages/server/src/cli/index.ts`（注册）

**Interfaces:**
- Produces: `codexAdapter: CliAgentAdapter`（id "codex"，无状态 `parseLine`）。

- [ ] **Step 1: 写失败测试** `packages/server/src/cli/codex.test.ts`（fixture 均来自 2026-07-06 真机 codex-cli 0.142.5，见计划头部背景事实；file_change/mcp/reasoning 按 codex-rs schema）：

```ts
import { describe, it, expect } from "vitest";
import { AgentEvent } from "@pocket-code/wire";
import { codexAdapter } from "./codex.js";

const P = (obj: unknown) => codexAdapter.parseLine!(JSON.stringify(obj));

describe("codexAdapter.parseLine", () => {
  it("ignores thread/turn lifecycle and junk lines", () => {
    expect(P({ type: "thread.started", thread_id: "019f" })).toEqual([]);
    expect(P({ type: "turn.started" })).toEqual([]);
    expect(codexAdapter.parseLine!("not json")).toEqual([]);
    expect(codexAdapter.parseLine!("")).toEqual([]);
  });

  it("maps agent_message to text-delta (真机 fixture)", () => {
    expect(P({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Hi there friend" } }))
      .toEqual([{ type: "text-delta", text: "Hi there friend" }]);
  });

  it("maps reasoning to reasoning-delta, skipping empty text", () => {
    expect(P({ type: "item.completed", item: { id: "r1", type: "reasoning", text: "think" } }))
      .toEqual([{ type: "reasoning-delta", text: "think" }]);
    expect(P({ type: "item.completed", item: { id: "r2", type: "reasoning", text: "" } })).toEqual([]);
  });

  it("maps command_execution started/completed to tool-call/tool-result (真机 fixture,失败命令 isError)", () => {
    const started = P({
      type: "item.started",
      item: { id: "item_0", type: "command_execution", command: "/bin/zsh -lc \"sed -n ...\"", aggregated_output: "", exit_code: null, status: "in_progress" },
    });
    expect(started).toEqual([
      { type: "tool-call", callId: "item_0", name: "runCommand", args: { command: "/bin/zsh -lc \"sed -n ...\"" } },
    ]);
    const completed = P({
      type: "item.completed",
      item: { id: "item_0", type: "command_execution", command: "...", aggregated_output: "sed: ...: No such file or directory\n", exit_code: 1, status: "failed" },
    });
    expect(completed).toEqual([
      { type: "tool-result", callId: "item_0", result: { output: "sed: ...: No such file or directory\n", exitCode: 1 }, isError: true },
    ]);
    // 成功命令无 isError
    const ok = P({
      type: "item.completed",
      item: { id: "i2", type: "command_execution", command: "ls", aggregated_output: "a\n", exit_code: 0, status: "completed" },
    });
    expect((ok[0] as any).isError).toBeUndefined();
  });

  it("maps file_change changes to file-changed events (add/update/delete)", () => {
    const evs = P({
      type: "item.completed",
      item: { id: "f1", type: "file_change", status: "completed", changes: [
        { path: "src/a.ts", kind: "add" },
        { path: "src/b.ts", kind: "update" },
        { path: "src/c.ts", kind: "delete" },
      ]},
    });
    expect(evs).toEqual([
      { type: "file-changed", path: "src/a.ts", changeType: "created" },
      { type: "file-changed", path: "src/b.ts", changeType: "modified" },
      { type: "file-changed", path: "src/c.ts", changeType: "deleted" },
    ]);
  });

  it("maps mcp_tool_call started/completed to tool-call/tool-result", () => {
    const started = P({ type: "item.started", item: { id: "m1", type: "mcp_tool_call", server: "ctx7", tool: "query", status: "in_progress" } });
    expect(started).toEqual([{ type: "tool-call", callId: "m1", name: "ctx7.query", args: {} }]);
    const done = P({ type: "item.completed", item: { id: "m1", type: "mcp_tool_call", server: "ctx7", tool: "query", status: "completed" } });
    expect((done[0] as any)).toMatchObject({ type: "tool-result", callId: "m1" });
  });

  it("maps turn.completed usage and error/turn.failed (真机 fixture)", () => {
    expect(P({ type: "turn.completed", usage: { input_tokens: 33890, cached_input_tokens: 21760, output_tokens: 268, reasoning_output_tokens: 166 } }))
      .toEqual([{ type: "usage", inputTokens: 33890, outputTokens: 268 }]);
    expect(P({ type: "error", message: "stream error: ...; retrying 1/5 in 208ms…" }))
      .toEqual([{ type: "error", message: "stream error: ...; retrying 1/5 in 208ms…" }]);
    expect(P({ type: "turn.failed", error: { message: "exceeded retry limit, last status: 401 Unauthorized" } }))
      .toEqual([{ type: "error", message: "exceeded retry limit, last status: 401 Unauthorized" }]);
  });

  it("ignores unknown item types (todo_list/web_search)", () => {
    expect(P({ type: "item.completed", item: { id: "t", type: "todo_list", items: [] } })).toEqual([]);
    expect(P({ type: "item.updated", item: { id: "x", type: "agent_message", text: "partial" } })).toEqual([]); // 增量忽略
  });

  it("all produced events pass wire AgentEvent.safeParse", () => {
    const all = [
      ...P({ type: "item.completed", item: { id: "a", type: "agent_message", text: "x" } }),
      ...P({ type: "item.started", item: { id: "c", type: "command_execution", command: "ls" } }),
      ...P({ type: "item.completed", item: { id: "c", type: "command_execution", command: "ls", aggregated_output: "", exit_code: 0 } }),
      ...P({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } }),
      ...P({ type: "turn.failed", error: { message: "e" } }),
    ];
    for (const ev of all) expect(AgentEvent.safeParse(ev).success).toBe(true);
  });
});

describe("codexAdapter.buildSpawn", () => {
  it("builds codex exec args with json/skip-git-repo-check/bypass, keeps env untouched", () => {
    process.env.__CODEX_TEST_SENTINEL = "keepme";
    const spec = codexAdapter.buildSpawn("do it", { workspace: "/ws" });
    expect(spec.cmd).toBe(process.env.CODEX_CLI_PATH || "codex");
    expect(spec.args).toEqual([
      "exec", "--json",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "do it",
    ]);
    expect(spec.cwd).toBe("/ws");
    expect(spec.env.__CODEX_TEST_SENTINEL).toBe("keepme"); // env 不清理(尊重 config.toml)
    delete process.env.__CODEX_TEST_SENTINEL;
  });

  it("prefixes customPrompt into the message", () => {
    const spec = codexAdapter.buildSpawn("msg", { workspace: "/ws", customPrompt: "rules" });
    expect(spec.args[spec.args.length - 1]).toBe("## Project Instructions\nrules\n\nmsg");
  });
});
```

- [ ] **Step 2: 确认失败**

Run: `pnpm --filter @pocket-code/server test src/cli/codex.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现** `packages/server/src/cli/codex.ts`：

```ts
// ── codex 适配器 ────────────────────────────────────────────
// codex exec --json 的 JSONL 事件流 → 归一化 AgentEvent。
// fixture 依据:2026-07-06 真机 codex-cli 0.142.5(见 P8 计划背景事实)。
// env 不清理:codex 认自己的 ~/.codex/config.toml(镜像/模型为用户主动配置),
// 与 claude 适配器"清 ANTHROPIC_*"策略相反且有意。

import type { AgentEventType } from "@pocket-code/wire";
import type { CliAgentAdapter, CliSpawnContext, CliSpawnSpec } from "./types.js";

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
  changes?: Array<{ path?: string; kind?: string }>;
  server?: string;
  tool?: string;
}

interface CodexLine {
  type?: string;
  item?: CodexItem;
  usage?: { input_tokens?: number; output_tokens?: number };
  message?: string;
  error?: { message?: string };
}

const KIND_TO_CHANGE: Record<string, "created" | "modified" | "deleted"> = {
  add: "created",
  update: "modified",
  delete: "deleted",
};

export const codexAdapter: CliAgentAdapter = {
  id: "codex",
  supportsResume: false,

  buildSpawn(userMessage: string, ctx: CliSpawnContext): CliSpawnSpec {
    const message = ctx.customPrompt?.trim()
      ? `## Project Instructions\n${ctx.customPrompt.trim()}\n\n${userMessage}`
      : userMessage;
    return {
      cmd: process.env.CODEX_CLI_PATH || "codex",
      args: [
        "exec", "--json",
        // workspace 可能不是 git 仓库/不在 codex 信任列表
        "--skip-git-repo-check",
        // 与 claude 路径 --dangerously-skip-permissions 同级信任(个人工具)
        "--dangerously-bypass-approvals-and-sandbox",
        message,
      ],
      env: { ...process.env },
      cwd: ctx.workspace,
    };
  },

  parseLine(line: string): AgentEventType[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let evt: CodexLine;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      return [];
    }

    switch (evt.type) {
      case "item.started": {
        const item = evt.item;
        if (!item?.id) return [];
        if (item.type === "command_execution") {
          return [{
            type: "tool-call", callId: item.id, name: "runCommand",
            args: { command: item.command ?? "" },
          }];
        }
        if (item.type === "mcp_tool_call") {
          return [{
            type: "tool-call", callId: item.id,
            name: `${item.server ?? "mcp"}.${item.tool ?? "tool"}`,
            args: {},
          }];
        }
        return [];
      }

      case "item.completed": {
        const item = evt.item;
        if (!item) return [];
        switch (item.type) {
          case "agent_message":
            return item.text ? [{ type: "text-delta", text: item.text }] : [];
          case "reasoning":
            return item.text ? [{ type: "reasoning-delta", text: item.text }] : [];
          case "command_execution": {
            if (!item.id) return [];
            const exitCode = item.exit_code ?? 0;
            return [{
              type: "tool-result", callId: item.id,
              result: { output: item.aggregated_output ?? "", exitCode },
              ...(exitCode !== 0 ? { isError: true } : {}),
            }];
          }
          case "file_change": {
            const events: AgentEventType[] = [];
            for (const c of item.changes ?? []) {
              const changeType = KIND_TO_CHANGE[c.kind ?? ""];
              if (c.path && changeType) {
                events.push({ type: "file-changed", path: c.path, changeType });
              }
            }
            return events;
          }
          case "mcp_tool_call":
            return item.id
              ? [{ type: "tool-result", callId: item.id, result: item }]
              : [];
          default:
            return []; // todo_list/web_search 等:无 UI 消费者
        }
      }

      case "turn.completed": {
        const u = evt.usage;
        return u
          ? [{ type: "usage", inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0 }]
          : [];
      }

      case "error":
        return evt.message ? [{ type: "error", message: evt.message }] : [];

      case "turn.failed":
        return [{ type: "error", message: evt.error?.message ?? "codex turn failed" }];

      // thread.started / turn.started / item.updated(增量,按完整消息出 text 的既有取舍) 等忽略
      default:
        return [];
    }
  },
};
```

`cli/index.ts` 注册（同 Task 2 模式）。

- [ ] **Step 4: 确认通过**

Run: `pnpm --filter @pocket-code/server test src/cli/`
Expected: 全 PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/cli/codex.ts packages/server/src/cli/codex.test.ts packages/server/src/cli/index.ts
git commit -m "feat(server): codexAdapter(exec --json JSONL→AgentEvent,真机 fixture 驱动)"
```

---

### Task 4: 注册表路由 + runCliSession + 删 cliRunner

**Files:**
- Modify: `packages/server/src/cli/index.ts`（`runCliSession`）、`packages/server/src/agent.ts`
- Create: `packages/server/src/cli/session.test.ts`
- Delete: `packages/server/src/cliRunner.ts`、`packages/server/src/cliRunner.gemini.test.ts`

**Interfaces:**
- Consumes: 注册表三适配器、`runCliAgent`。
- Produces: `runCliSession(adapter, session, userMessage, onEvent, signal?): Promise<void>`——运行 CLI 并把 assistant 全文 push 进 `session.messages`（`fullText || "(<id> completed)"`）。

- [ ] **Step 1: 写失败测试** `packages/server/src/cli/session.test.ts`：

```ts
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { runCliSession, cliAdapters } from "./index.js";

function makeFakeProc() {
  const proc: any = new EventEmitter();
  proc.pid = 4242;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { end: vi.fn() };
  proc.kill = vi.fn();
  proc.pushLine = (obj: unknown) => proc.stdout.emit("data", Buffer.from(JSON.stringify(obj) + "\n"));
  proc.finish = (code = 0) => proc.emit("close", code);
  return proc;
}

describe("cliAdapters registry", () => {
  it("contains all three adapters", () => {
    expect(Object.keys(cliAdapters).sort()).toEqual(["claude-code", "codex", "gemini-cli"]);
  });
});

describe("runCliSession", () => {
  it("runs the adapter and pushes assistant full text into session.messages", async () => {
    const session: any = { workspace: "/ws", customPrompt: undefined, messages: [] };
    const proc = makeFakeProc();
    const events: any[] = [];
    const p = runCliSession(cliAdapters["codex"], session, "hi", (e) => events.push(e), undefined, () => proc);
    proc.pushLine({ type: "item.completed", item: { id: "i1", type: "agent_message", text: "done!" } });
    proc.finish(0);
    await p;
    expect(session.messages).toEqual([{ role: "assistant", content: "done!" }]);
    expect(events.map((e: any) => e.type)).toContain("text-delta");
  });

  it("pushes a placeholder when CLI produced no text", async () => {
    const session: any = { workspace: "/ws", messages: [] };
    const proc = makeFakeProc();
    const p = runCliSession(cliAdapters["codex"], session, "hi", () => {}, undefined, () => proc);
    proc.finish(0);
    await p;
    expect(session.messages[0].content).toBe("(codex completed)");
  });
});
```

- [ ] **Step 2: 确认失败**

Run: `pnpm --filter @pocket-code/server test src/cli/session.test.ts`
Expected: FAIL（runCliSession 不存在）

- [ ] **Step 3: 实现**。`cli/index.ts` 追加（注意 `spawnFn` 透传以便测试注入；`AgentSession` 用 `import type` 防运行时循环）：

```ts
import type { AgentEventType } from "@pocket-code/wire";
import type { AgentSession } from "../agent.js";
import { runCliAgent, type SpawnFn } from "./runner.js";   // SpawnFn 若未导出,按 runner.ts 实际类型名导出后引用

/** 通用 CLI 会话包装:运行适配器,结束后把 assistant 全文写入会话历史。 */
export async function runCliSession(
  adapter: CliAgentAdapter,
  session: AgentSession,
  userMessage: string,
  onEvent: (ev: AgentEventType) => void,
  signal?: AbortSignal,
  spawnFn?: SpawnFn
): Promise<void> {
  console.log(`[CLI] ${adapter.id}: workspace=${session.workspace}, msg="${userMessage.slice(0, 80)}"`);
  const fullText = await runCliAgent(
    adapter,
    userMessage,
    { workspace: session.workspace, customPrompt: session.customPrompt },
    onEvent,
    signal,
    spawnFn
  );
  session.messages.push({ role: "assistant", content: fullText || `(${adapter.id} completed)` });
}
```

`agent.ts`：
① 删除 `import { runClaudeCodeAgent, runGeminiCliAgent } from "./cliRunner.js";`，改 `import { cliAdapters, runCliSession } from "./cli/index.js";`
② 两个 if 块（L160-171）替换为：

```ts
  // ── CLI routing: 注册表命中即委托本机 CLI 工具 ──
  const cliAdapter = cliAdapters[session.modelKey];
  if (cliAdapter) {
    session.messages.push({ role: "user", content: userMessage });
    await runCliSession(cliAdapter, session, userMessage, onEvent, signal);
    saveSession(session.sessionId, session.userId, session.messages, session.modelKey, session.projectId);
    return;
  }
```

③ `MODELS` 表加一行（gemini-cli 条目旁）：`"codex": { provider: "cli-codex", modelId: "codex" },`

④ 删除文件：

```bash
git rm packages/server/src/cliRunner.ts packages/server/src/cliRunner.gemini.test.ts
```

- [ ] **Step 4: 验证（构建 + 全测试 + 死代码断言）**

Run: `pnpm --filter @pocket-code/server build && pnpm --filter @pocket-code/server test && grep -rn "cliRunner" packages/*/src/; echo "grep=$?"`
Expected: 构建零错误、全 PASS、grep=1（零命中）

- [ ] **Step 5: 提交**

```bash
git add -A packages/server/src
git commit -m "refactor(server): CLI 路由改注册表查找+runCliSession 通用包装,删除 cliRunner(P3 技术债清零)"
```

---

### Task 5: App 模型入口 + E2E 守卫 + 全仓验证

**Files:**
- Modify: `packages/app/src/services/modelConfig.ts`
- Create: `packages/server/src/cli/codex.e2e.test.ts`、`packages/server/src/cli/gemini.e2e.test.ts`

- [ ] **Step 1: App 加 Codex 条目**。`modelConfig.ts` 的 gemini-cli 条目之后插入：

```ts
    {
        key: "codex",
        label: "Codex (ChatGPT)",
        description: "服务器 Codex CLI 订阅，无需 API Key",
        provider: "cli-codex",
        modelId: "codex",
        baseURL: "",
        cloudOnly: true,
    },
```

- [ ] **Step 2: E2E（RUN_CLI_E2E 守卫,模式照抄 claudeCode.e2e.test.ts）**。`codex.e2e.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEventType } from "@pocket-code/wire";
import { AgentEvent } from "@pocket-code/wire";
import { runCliAgent } from "./runner.js";
import { codexAdapter } from "./codex.js";

function cliAvailable(): boolean {
  try { execSync("command -v codex", { stdio: "ignore" }); return true; } catch { return false; }
}
const ENABLED = !!process.env.RUN_CLI_E2E && cliAvailable();

// 手动 RUN_CLI_E2E=1 且本机 codex 已登录时运行;依赖账号/网络可用。
describe.skipIf(!ENABLED)("codex E2E (real CLI)", () => {
  it("drives real codex to write a file and emits well-formed AgentEvents", async () => {
    const ws = mkdtempSync(join(tmpdir(), "pc-e2e-codex-"));
    const events: AgentEventType[] = [];
    await runCliAgent(
      codexAdapter,
      "Create a file named hello.txt containing exactly the text: hi. Then stop.",
      { workspace: ws },
      (e) => events.push(e)
    );
    for (const ev of events) expect(AgentEvent.safeParse(ev).success).toBe(true);
    expect(events.at(-1)?.type).toBe("done");
    expect(existsSync(join(ws, "hello.txt"))).toBe(true);
    expect(readFileSync(join(ws, "hello.txt"), "utf-8").trim()).toBe("hi");
  }, 300_000);
});
```

`gemini.e2e.test.ts` 同构（`command -v gemini`、`geminiAdapter`、`"pc-e2e-gemini-"` 前缀、describe 名 "gemini-cli E2E (real CLI)"，其余逐行相同）。

- [ ] **Step 3: 全仓验证**

Run: `pnpm build && pnpm test:all && pnpm typecheck:app`
Expected: 全绿

- [ ] **Step 4: 真机 E2E（本机两个 CLI 都在,顺手跑）**

Run: `RUN_CLI_E2E=1 pnpm --filter @pocket-code/server test src/cli/codex.e2e.test.ts src/cli/gemini.e2e.test.ts`
Expected: PASS（若 codex/gemini 账号或后端故障导致失败,记录输出、不阻塞——spec §6 风险预案）

- [ ] **Step 5: 提交**

```bash
git add packages/app/src/services/modelConfig.ts packages/server/src/cli/codex.e2e.test.ts packages/server/src/cli/gemini.e2e.test.ts
git commit -m "feat(app,server): App 增 Codex 模型入口+codex/gemini 真机 E2E(RUN_CLI_E2E 守卫)"
```

---

## 验收对照（spec §5）

1. 构建/测试/typecheck 全绿 + `cliRunner` 零命中 → Task 4 Step 4、Task 5 Step 3。
2. 手机选 Codex/Gemini 全链路 → 交付后用户真机验收（本机 E2E 在 Task 5 Step 4 先行验证 CLI 层）。
3. claude-code 回归 → 现有测试不改全过 + 用户真机回归。
