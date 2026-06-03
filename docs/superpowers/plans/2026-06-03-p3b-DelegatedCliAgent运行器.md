# P3b DelegatedCliAgent 运行器（灰度接入 + 真机 claude 验证）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 claude-code 的真实运行路径改用 P3a 的 `claudeCodeAdapter`：新增通用 `runCliAgent` 运行器（进程生命周期 + 适配器 → AgentEvent 流）+ `AgentEvent→StreamEvent` 桥接，重构 `runClaudeCodeAgent` 复用它们（删除重复的 `parseClaudeLine`），App/messageHandler 零改动（灰度）。

**Architecture:** 三层解耦：① `runner.ts` 的 `runCliAgent(adapter, userMessage, ctx, onEvent, signal, spawnFn?)`——管 spawn/行缓冲/parseLine→emit AgentEvent/close→done/error→error/abort→killTree，`spawnFn` 可注入便于测试，返回累计的 assistant 文本；② `bridge.ts` 的有状态转换器把 `AgentEvent` 映射回旧 `StreamEvent`（并用 callId→toolName 记忆补全 tool-result 的 toolName）；③ 重构 `runClaudeCodeAgent` 用前两者，保持外部签名与行为不变。真实 claude 已验证 P3a 适配器解析正确（claude-code 2.1.160），本计划含一个受 `RUN_CLI_E2E` 守卫的真机集成测试。

**Tech Stack:** TypeScript、Node child_process、vitest（含可注入 spawn 的 fake 进程）、`@pocket-code/wire` 的 AgentEvent。

---

## 背景事实（执行者必读）

- 已用真实 claude-code 2.1.160 验证：P3a 的 `claudeCodeAdapter.parseLine` 对 `assistant(text/thinking/tool_use)`、`user(tool_result, content 可为字符串、成功时 is_error 缺省)`、`result(subtype=success, usage.input_tokens/output_tokens)` 的解析**全部正确**；`system/stream_event/rate_limit_event` 被忽略。**唯一可优化**：thinking 块可能是空串（仅含 signature），应跳过空 thinking。
- `runClaudeCodeAgent`（`cliRunner.ts:64-157`）当前行为：spawn claude → `proc.stdin.end()`（立即关 stdin，避免 claude 等待 3s）→ 行缓冲解析 → 累计 fullText → close 时 `session.messages.push({role:"assistant",content:fullText})` + `onEvent({type:"done"})`；claude 常以非零码退出，故"收到成功结果就忽略非零退出码"。
- 旧 `StreamEvent`（`agent.ts:145-154`，messageHandler/App 消费的契约）与归一化 `AgentEvent` 字段差异：
  - `tool-call`: 旧 `{toolName, args}` ↔ 新 `{callId, name, args}`
  - `tool-result`: 旧 `{toolName, result}` ↔ 新 `{callId, result, isError?}`
  - `usage`: 旧 `{promptTokens, completionTokens, totalTokens}` ↔ 新 `{inputTokens, outputTokens}`
  - `error`: 旧 `{error}` ↔ 新 `{message, code?}`
  - `model-selected`: 旧 `{model, reason}` ↔ 新 `{modelKey, reason}`
  - `file-changed`: 旧 `{path, action}` ↔ 新 `{path, changeType, oldContent?, newContent?}`
  - `text-delta`/`reasoning-delta`/`done`: 两边一致
- `runAgent`（`agent.ts:169-174`）在 `modelKey==="claude-code"` 时 push user 消息后调用 `runClaudeCodeAgent(session, userMessage, onEvent, signal)` 再 saveSession。**本计划不改 agent.ts/messageHandler.ts/app**——只改 `cliRunner.ts` 内部并新增 `cli/` 文件。
- `killProcessTree`/`isProcessAlive` 现于 `cliRunner.ts:9-55`，运行器需要它们——本计划将其移到 `cli/runner.ts` 并从 `cliRunner.ts` 复用（避免重复）。
- server 测试经 `vitest run src` 递归扫 `src/`，新测试自动纳入。真机 E2E 测试用 `describe.skipIf(!process.env.RUN_CLI_E2E || !CLAUDE_AVAILABLE)` 守卫——CI（无 claude）与日常 `pnpm test`（无 RUN_CLI_E2E）都跳过，只在手动 `RUN_CLI_E2E=1` 且本机装了 claude 时运行，避免无谓消耗额度。

## 文件结构（本计划涉及）

- 修改：`packages/server/src/cli/claudeCode.ts`（跳过空 thinking）+ `claudeCode.test.ts`（加用例）
- 新建：`packages/server/src/cli/bridge.ts`（AgentEvent→StreamEvent 转换器）+ `bridge.test.ts`
- 新建：`packages/server/src/cli/runner.ts`（`runCliAgent` + 进程树终止工具）+ `runner.test.ts`
- 新建：`packages/server/src/cli/claudeCode.e2e.test.ts`（真机 claude，受守卫）
- 修改：`packages/server/src/cliRunner.ts`（`runClaudeCodeAgent` 复用 runner+bridge，删 `parseClaudeLine` 与本地 kill 工具）

> 所有命令均在仓库根目录 `/Users/worsher/code/self/pocket-code` 执行。

---

### Task 1: 适配器跳过空 thinking 块

**Files:**
- Modify: `packages/server/src/cli/claudeCode.ts`
- Modify: `packages/server/src/cli/claudeCode.test.ts`

- [ ] **Step 1: 加失败测试**

在 `packages/server/src/cli/claudeCode.test.ts` 的 `describe("claudeCodeAdapter.parseLine", ...)` 块内，`it("maps assistant thinking block to reasoning-delta", ...)` 之后插入：

```typescript
  it("skips empty thinking blocks (signature-only)", () => {
    const evs = claudeCodeAdapter.parseLine(
      line({ type: "assistant", message: { content: [{ type: "thinking", thinking: "", signature: "x" }] } })
    );
    expect(evs).toEqual([]);
  });
```

- [ ] **Step 2: 跑测试确认新用例失败**

Run: `pnpm --filter @pocket-code/wire build && pnpm --filter @pocket-code/server test`
Expected: FAIL —— 新用例失败（当前空 thinking 会产出 `{type:"reasoning-delta",text:""}`）。

- [ ] **Step 3: 实现跳过空 thinking**

在 `packages/server/src/cli/claudeCode.ts` 的 `parseLine` 中，把：

```typescript
          } else if (block?.type === "thinking" && typeof block.thinking === "string") {
            events.push({ type: "reasoning-delta", text: block.thinking });
```

替换为：

```typescript
          } else if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.length > 0) {
            events.push({ type: "reasoning-delta", text: block.thinking });
```

- [ ] **Step 4: 跑测试确认全绿，提交**

Run: `pnpm --filter @pocket-code/server test`
Expected: PASS —— claudeCode.test.ts 全过（含新用例）。

```bash
git add packages/server/src/cli/claudeCode.ts packages/server/src/cli/claudeCode.test.ts
git commit -m "fix(server): claude 适配器跳过空 thinking 块(真机验证发现)"
```

---

### Task 2: AgentEvent→StreamEvent 桥接

**Files:**
- Create: `packages/server/src/cli/bridge.test.ts`（先写）
- Create: `packages/server/src/cli/bridge.ts`（实现）

- [ ] **Step 1: 先写失败测试**

创建 `packages/server/src/cli/bridge.test.ts`，内容：

```typescript
import { describe, it, expect } from "vitest";
import type { AgentEventType } from "@pocket-code/wire";
import { createAgentEventToStreamEvent } from "./bridge.js";

describe("createAgentEventToStreamEvent", () => {
  it("passes text-delta / reasoning-delta / done through unchanged", () => {
    const c = createAgentEventToStreamEvent();
    expect(c({ type: "text-delta", text: "a" })).toEqual({ type: "text-delta", text: "a" });
    expect(c({ type: "reasoning-delta", text: "t" })).toEqual({ type: "reasoning-delta", text: "t" });
    expect(c({ type: "done" })).toEqual({ type: "done" });
  });

  it("maps tool-call to old shape and remembers callId→name for tool-result", () => {
    const c = createAgentEventToStreamEvent();
    const call: AgentEventType = { type: "tool-call", callId: "id1", name: "runCommand", args: { command: "ls" } };
    expect(c(call)).toEqual({ type: "tool-call", toolName: "runCommand", args: { command: "ls" } });
    const result: AgentEventType = { type: "tool-result", callId: "id1", result: "ok", isError: false };
    expect(c(result)).toEqual({ type: "tool-result", toolName: "runCommand", result: "ok" });
  });

  it("uses empty toolName when tool-result has no matching prior call", () => {
    const c = createAgentEventToStreamEvent();
    expect(c({ type: "tool-result", callId: "unknown", result: "r" })).toEqual({
      type: "tool-result",
      toolName: "",
      result: "r",
    });
  });

  it("maps usage to prompt/completion/total tokens", () => {
    const c = createAgentEventToStreamEvent();
    expect(c({ type: "usage", inputTokens: 10, outputTokens: 20 })).toEqual({
      type: "usage",
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
    });
  });

  it("maps error message and model-selected/file-changed field names", () => {
    const c = createAgentEventToStreamEvent();
    expect(c({ type: "error", message: "boom" })).toEqual({ type: "error", error: "boom" });
    expect(c({ type: "model-selected", modelKey: "claude-sonnet", reason: "complex" })).toEqual({
      type: "model-selected",
      model: "claude-sonnet",
      reason: "complex",
    });
    expect(c({ type: "file-changed", path: "a.ts", changeType: "modified" })).toEqual({
      type: "file-changed",
      path: "a.ts",
      action: "modified",
    });
  });

  it("returns null for events with no old-StreamEvent equivalent (command-output/process/preview)", () => {
    const c = createAgentEventToStreamEvent();
    expect(c({ type: "command-output", callId: "c", chunk: "x", stream: "stdout" })).toBeNull();
    expect(c({ type: "process-started", processId: "p", command: "npm" })).toBeNull();
    expect(c({ type: "process-exited", processId: "p", exitCode: 0 })).toBeNull();
    expect(c({ type: "preview-available", url: "http://x", source: "dev-server" })).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @pocket-code/server test`
Expected: FAIL —— 无法解析 `./bridge.js`。

- [ ] **Step 3: 实现桥接**

创建 `packages/server/src/cli/bridge.ts`，内容：

```typescript
// ── AgentEvent → 旧 StreamEvent 桥接(灰度) ──────────────────
// P3b 让 CLI 路径内部产出归一化 AgentEvent,但 messageHandler/App 仍消费
// 旧 StreamEvent。此转换器做字段映射;并记忆 tool-call 的 callId→name,
// 以便 tool-result 携带真实 toolName(旧解析里曾是占位 "_claude_tool")。
// App 迁移到原生消费 AgentEvent 后(后续计划)可移除本桥接。

import type { AgentEventType } from "@pocket-code/wire";
import type { StreamEvent } from "../agent.js";

export function createAgentEventToStreamEvent(): (ev: AgentEventType) => StreamEvent | null {
  const callNames = new Map<string, string>();

  return (ev: AgentEventType): StreamEvent | null => {
    switch (ev.type) {
      case "text-delta":
        return { type: "text-delta", text: ev.text };
      case "reasoning-delta":
        return { type: "reasoning-delta", text: ev.text };
      case "tool-call":
        if (ev.callId) callNames.set(ev.callId, ev.name);
        return { type: "tool-call", toolName: ev.name, args: ev.args };
      case "tool-result":
        return {
          type: "tool-result",
          toolName: callNames.get(ev.callId) ?? "",
          result: ev.result,
        };
      case "usage":
        return {
          type: "usage",
          promptTokens: ev.inputTokens,
          completionTokens: ev.outputTokens,
          totalTokens: ev.inputTokens + ev.outputTokens,
        };
      case "error":
        return { type: "error", error: ev.message };
      case "model-selected":
        return { type: "model-selected", model: ev.modelKey, reason: ev.reason ?? "" };
      case "file-changed":
        return { type: "file-changed", path: ev.path, action: ev.changeType };
      case "done":
        return { type: "done" };
      // command-output / process-started / process-exited / preview-available
      // 在旧 StreamEvent 中无对应,灰度期丢弃(App 迁移后原生消费)。
      default:
        return null;
    }
  };
}
```

- [ ] **Step 4: 跑测试确认全绿，提交**

Run: `pnpm --filter @pocket-code/server test`
Expected: PASS —— bridge.test.ts 全过。

```bash
git add packages/server/src/cli/bridge.ts packages/server/src/cli/bridge.test.ts
git commit -m "feat(server): AgentEvent→StreamEvent 灰度桥接(含 callId→toolName 记忆)"
```

---

### Task 3: 通用 runCliAgent 运行器（可注入 spawn）

**Files:**
- Create: `packages/server/src/cli/runner.test.ts`（先写）
- Create: `packages/server/src/cli/runner.ts`（实现，含进程树终止工具）

- [ ] **Step 1: 先写失败测试（用 fake spawn 喂合成 NDJSON）**

创建 `packages/server/src/cli/runner.test.ts`，内容：

```typescript
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { AgentEventType } from "@pocket-code/wire";
import { runCliAgent } from "./runner.js";
import { claudeCodeAdapter } from "./claudeCode.js";

/** 造一个最小的 fake ChildProcess:可推送 stdout 行、触发 close。 */
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

const ctx = { workspace: "/ws" };

describe("runCliAgent", () => {
  it("spawns via adapter.buildSpawn, ends stdin, streams AgentEvents, emits done, returns text", async () => {
    const proc = makeFakeProc();
    const spawnFn = vi.fn().mockReturnValue(proc);
    const events: AgentEventType[] = [];

    const p = runCliAgent(claudeCodeAdapter, "hi", ctx, (e) => events.push(e), undefined, spawnFn);

    // spawn 调用了 claude,且关了 stdin
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(spawnFn.mock.calls[0][0]).toBe(process.env.CLAUDE_CLI_PATH || "claude");
    expect(proc.stdin.end).toHaveBeenCalled();

    proc.pushLine({ type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } });
    proc.pushLine({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "a" } }] },
    });
    proc.pushLine({ type: "result", subtype: "success", usage: { input_tokens: 1, output_tokens: 2 } });
    proc.finish(0);

    const text = await p;

    const types = events.map((e) => e.type);
    expect(types).toContain("text-delta");
    expect(types).toContain("tool-call");
    expect(types).toContain("usage");
    expect(types[types.length - 1]).toBe("done"); // 末事件必为 done
    expect(text).toBe("Hello"); // 累计 text-delta
  });

  it("handles a line split across two stdout chunks", async () => {
    const proc = makeFakeProc();
    const events: AgentEventType[] = [];
    const p = runCliAgent(claudeCodeAdapter, "hi", ctx, (e) => events.push(e), undefined, () => proc);
    const full = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "split" }] } });
    proc.stdout.emit("data", Buffer.from(full.slice(0, 10)));
    proc.stdout.emit("data", Buffer.from(full.slice(10) + "\n"));
    proc.finish(0);
    await p;
    expect(events.find((e) => e.type === "text-delta")).toEqual({ type: "text-delta", text: "split" });
  });

  it("emits a single error when process closes non-zero with no output", async () => {
    const proc = makeFakeProc();
    const events: AgentEventType[] = [];
    const p = runCliAgent(claudeCodeAdapter, "hi", ctx, (e) => events.push(e), undefined, () => proc);
    proc.finish(1);
    await p;
    expect(events.filter((e) => e.type === "error")).toHaveLength(1);
    expect(events[events.length - 1].type).toBe("done");
  });

  it("does NOT emit error on non-zero exit when output was produced", async () => {
    const proc = makeFakeProc();
    const events: AgentEventType[] = [];
    const p = runCliAgent(claudeCodeAdapter, "hi", ctx, (e) => events.push(e), undefined, () => proc);
    proc.pushLine({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } });
    proc.finish(1);
    await p;
    expect(events.filter((e) => e.type === "error")).toHaveLength(0);
  });

  it("kills the process tree when the abort signal fires", async () => {
    const proc = makeFakeProc();
    const ac = new AbortController();
    const events: AgentEventType[] = [];
    const p = runCliAgent(claudeCodeAdapter, "hi", ctx, (e) => events.push(e), ac.signal, () => proc);
    ac.abort();
    proc.finish(0);
    await p;
    expect(proc.kill).toHaveBeenCalled(); // 进程被终止(pid 路径或回退到 proc.kill)
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @pocket-code/server test`
Expected: FAIL —— 无法解析 `./runner.js`。

- [ ] **Step 3: 实现运行器**

创建 `packages/server/src/cli/runner.ts`，内容：

```typescript
// ── 通用 CLI Agent 运行器 ──────────────────────────────────
// 用一个 CliAgentAdapter 驱动子进程,把其 NDJSON 输出归一化为 AgentEvent 流。
// 与具体 CLI 解耦:进程生命周期/行缓冲/abort/退出码判定在此,解析在适配器。
// spawnFn 可注入,便于单测(默认用 child_process.spawn)。

import { spawn as nodeSpawn } from "node:child_process";
import type { AgentEventType } from "@pocket-code/wire";
import type { CliAgentAdapter, CliSpawnContext } from "./types.js";

export type SpawnFn = typeof nodeSpawn;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 跨平台进程树终止:先 SIGTERM,grace 后 SIGKILL(用进程组信号)。 */
export function killProcessTree(pid: number, graceMs = 3000): void {
  if (!Number.isFinite(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    try {
      nodeSpawn("taskkill", ["/T", "/PID", String(pid)], { stdio: "ignore", detached: true });
    } catch { /* ignore */ }
    setTimeout(() => {
      if (!isProcessAlive(pid)) return;
      try {
        nodeSpawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", detached: true });
      } catch { /* ignore */ }
    }, graceMs).unref();
    return;
  }
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

/**
 * 运行一个 CLI 代理。把适配器解析出的 AgentEvent 通过 onEvent 流式发出,
 * 结尾必发一个 done。返回累计的 assistant 文本(供上层写入会话历史)。
 */
export function runCliAgent(
  adapter: CliAgentAdapter,
  userMessage: string,
  ctx: CliSpawnContext,
  onEvent: (event: AgentEventType) => void,
  signal?: AbortSignal,
  spawnFn: SpawnFn = nodeSpawn
): Promise<string> {
  const spec = adapter.buildSpawn(userMessage, ctx);

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
    if (event.type === "error") errorEmitted = true;
    if (event.type !== "done") producedOutput = true;
    onEvent(event);
  };

  const drainLine = (line: string) => {
    for (const ev of adapter.parseLine(line)) handle(ev);
  };

  return new Promise<string>((resolve) => {
    proc.stdout?.on("data", (chunk: Buffer) => {
      lineBuffer += chunk.toString("utf-8");
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) drainLine(line);
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      const msg = chunk.toString("utf-8").trim();
      if (msg) console.warn(`[CLI:${adapter.id}] stderr:`, msg.slice(0, 300));
    });

    proc.on("close", (code: number | null) => {
      if (lineBuffer.trim()) drainLine(lineBuffer);
      // CLI 常以非零码退出却实际成功:只有"零输出且非中止且未报错"才判为失败。
      if (code !== 0 && !signal?.aborted && !producedOutput && !errorEmitted) {
        handle({ type: "error", message: `${adapter.id} 进程异常退出 (code=${code})` });
      }
      onEvent({ type: "done" });
      resolve(fullText);
    });

    proc.on("error", (err: Error) => {
      if (!errorEmitted) {
        onEvent({
          type: "error",
          message: `无法启动 ${adapter.id}: ${err.message}`,
        });
      }
      onEvent({ type: "done" });
      resolve(fullText);
    });
  });
}
```

- [ ] **Step 4: 跑测试确认全绿，提交**

Run: `pnpm --filter @pocket-code/server test`
Expected: PASS —— runner.test.ts 5 个用例全过。

```bash
git add packages/server/src/cli/runner.ts packages/server/src/cli/runner.test.ts
git commit -m "feat(server): 通用 runCliAgent 运行器(可注入 spawn,含进程树终止)"
```

---

### Task 4: 重构 runClaudeCodeAgent 复用 runner+bridge

**Files:**
- Modify: `packages/server/src/cliRunner.ts`（重写 claude 部分，删 parseClaudeLine 与本地 kill 工具）

- [ ] **Step 1: 重写 cliRunner.ts 的 claude 部分**

把 `packages/server/src/cliRunner.ts` 的**开头到 `runClaudeCodeAgent` 结束、含 `parseClaudeLine`**（第 1 行至第 220 行，即 `// ── Gemini CLI Runner ──` 之前的全部内容）替换为：

```typescript
/**
 * cliRunner.ts
 * 通过已安装的 CLI 工具（Claude Code / Gemini CLI）运行 AI Agent。
 * 适用于在服务器上使用 Pro 订阅额度、无需消耗 API Key 的场景。
 *
 * claude 路径已重构为复用 cli/ 下的 CliAgentAdapter + runCliAgent + 桥接;
 * gemini 路径暂保持原样(后续接入适配器)。
 */
import { spawn } from "child_process";
import type { AgentSession, StreamEvent } from "./agent.js";
import { claudeCodeAdapter } from "./cli/claudeCode.js";
import { runCliAgent, killProcessTree } from "./cli/runner.js";
import { createAgentEventToStreamEvent } from "./cli/bridge.js";

// ── Claude Code CLI Runner ────────────────────────────────

/**
 * 使用 claude CLI 运行:经 claudeCodeAdapter 解析为归一化 AgentEvent,
 * 再桥接回旧 StreamEvent 发给调用方(messageHandler/App 暂不变)。
 * 服务器上需全局安装并认证:npm install -g @anthropic-ai/claude-code
 */
export async function runClaudeCodeAgent(
  session: AgentSession,
  userMessage: string,
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  console.log(`[CLI] Claude Code: workspace=${session.workspace}, msg="${userMessage.slice(0, 80)}"`);

  const toStream = createAgentEventToStreamEvent();
  const fullText = await runCliAgent(
    claudeCodeAdapter,
    userMessage,
    { workspace: session.workspace, customPrompt: session.customPrompt },
    (ev) => {
      const se = toStream(ev);
      if (se) onEvent(se);
    },
    signal
  );

  session.messages.push({ role: "assistant", content: fullText || "(Claude Code completed)" });
}
```

> 说明：`runCliAgent` 已在结尾发出 `done`（经桥接转成旧 `done` StreamEvent），故这里不再手动发 done；`session.messages.push` 在 await 之后执行，时序与原先一致。`killProcessTree` 改从 `./cli/runner.js` 导入（gemini 部分仍用它），原文件内的 `isProcessAlive`/`killProcessTree` 定义已随上述替换删除。

- [ ] **Step 2: 确认 gemini 部分仍引用得到 killProcessTree / spawn**

`runGeminiCliAgent`（替换后保留在文件下半部）仍使用 `spawn` 和 `killProcessTree`——二者已分别由文件顶部的 `import { spawn }` 和 `import { ... killProcessTree } from "./cli/runner.js"` 提供。无需改动 gemini 部分。

- [ ] **Step 3: 构建并跑 server 测试**

Run: `pnpm build && pnpm --filter @pocket-code/server test`
Expected: 构建成功；server 测试全过。`cliRunner.ts` 不再含 `parseClaudeLine`，claude 路径走适配器。

- [ ] **Step 4: 全链路验证**

Run: `pnpm build && pnpm test:all && pnpm typecheck:app && echo ALL GREEN`
Expected: 末尾 `ALL GREEN`。

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/cliRunner.ts
git commit -m "refactor(server): runClaudeCodeAgent 复用 adapter+runner+桥接,删重复解析"
```

---

### Task 5: 真机 claude 集成测试（受守卫）

**Files:**
- Create: `packages/server/src/cli/claudeCode.e2e.test.ts`

- [ ] **Step 1: 创建受守卫的真机 E2E 测试**

创建 `packages/server/src/cli/claudeCode.e2e.test.ts`，内容：

```typescript
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEventType } from "@pocket-code/wire";
import { AgentEvent } from "@pocket-code/wire";
import { runCliAgent } from "./runner.js";
import { claudeCodeAdapter } from "./claudeCode.js";

function claudeAvailable(): boolean {
  try {
    execSync("command -v claude", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const ENABLED = !!process.env.RUN_CLI_E2E && claudeAvailable();

// 默认跳过:CI 无 claude、日常 test 无 RUN_CLI_E2E。仅手动 `RUN_CLI_E2E=1 pnpm --filter @pocket-code/server test` 且本机装了 claude 时运行。
describe.skipIf(!ENABLED)("claude-code E2E (real CLI)", () => {
  it("drives real claude to write a file and emits well-formed AgentEvents", async () => {
    const ws = mkdtempSync(join(tmpdir(), "pc-e2e-"));
    const events: AgentEventType[] = [];

    const text = await runCliAgent(
      claudeCodeAdapter,
      "Create a file named hello.txt containing exactly the text: hi. Then stop.",
      { workspace: ws },
      (e) => events.push(e)
    );

    // 每个事件都合法
    for (const e of events) {
      expect(AgentEvent.safeParse(e).success).toBe(true);
    }
    // 末事件为 done
    expect(events[events.length - 1].type).toBe("done");
    // 至少产生了文本或工具调用
    const types = new Set(events.map((e) => e.type));
    expect(types.has("text-delta") || types.has("tool-call")).toBe(true);
    // 真机确实写出了文件
    expect(existsSync(join(ws, "hello.txt"))).toBe(true);
    expect(readFileSync(join(ws, "hello.txt"), "utf-8").trim()).toBe("hi");
    // 返回的累计文本是字符串
    expect(typeof text).toBe("string");
  }, 120000);
});
```

- [ ] **Step 2: 确认默认跳过（不影响常规测试）**

Run: `pnpm --filter @pocket-code/server test`
Expected: PASS —— E2E 用例显示为 skipped（因未设 `RUN_CLI_E2E`），其余测试全过。

- [ ] **Step 3: 提交**

```bash
git add packages/server/src/cli/claudeCode.e2e.test.ts
git commit -m "test(server): 真机 claude-code E2E(受 RUN_CLI_E2E 守卫,默认跳过)"
```

> 真机验证（由控制者/用户手动执行，不属提交内容）：
> `pnpm --filter @pocket-code/wire build && RUN_CLI_E2E=1 pnpm --filter @pocket-code/server test`
> 预期：E2E 用例实际运行并通过（真实 claude 写出 hello.txt，事件流合法、以 done 结尾）。

---

## Self-Review

**1. Spec coverage（对照 spec 第 3.4 / 3.3 节）：**
- ✅ `DelegatedCliAgent` 运行逻辑：通用 `runCliAgent` 用 adapter 驱动进程、产出 AgentEvent → Task 3
- ✅ claude 真实路径改用适配器、删重复解析 → Task 4
- ✅ 灰度不破坏现有 App/messageHandler：AgentEvent→StreamEvent 桥接 → Task 2
- ✅ 真机验证适配器对真实 claude 正确 → Task 5（+ 已在规划期用真实 claude 2.1.160 预验证解析形态）
- 注：App 原生消费 AgentEvent（去桥接）、daemon/relay 边界校验、出站控制响应 schema = 后续计划（P3c/更后）。gemini-cli 适配器后续。

**2. Placeholder scan：** 无 TBD/TODO；每步含完整文件内容/替换与精确命令、预期输出。

**3. Type consistency：** 桥接输出严格匹配 `agent.ts` 的 `StreamEvent`（`tool-call.toolName`、`tool-result.toolName`、`usage.promptTokens/completionTokens/totalTokens`、`error.error`、`model-selected.model`、`file-changed.action`）；`runCliAgent` 形参 `onEvent: (AgentEventType)=>void` 与适配器 `parseLine` 产出一致；`killProcessTree` 在 runner 导出、cliRunner 与 runner 共用一处定义（消除原 cliRunner 内重复）。

**4. 风险：** Task 4 替换 `cliRunner.ts` 第 1–220 行需精确——若行号因前序改动漂移，以"文件开头至 `// ── Gemini CLI Runner ──` 注释之前"为边界。gemini 部分（`runGeminiCliAgent` 及其 `parseLine`）保持不变，依赖顶部 `import { spawn }` 与 `killProcessTree`。真机 E2E 受 `RUN_CLI_E2E` 守卫，CI 与日常测试不触发、不耗额度。
