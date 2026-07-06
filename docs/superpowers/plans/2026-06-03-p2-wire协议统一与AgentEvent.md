# P2 wire 协议统一 + 归一化 AgentEvent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `@pocket-code/wire` 成为入站协议的单一真相源（消除 server 里逐字节重复的 `wsSchemas.ts`），并在 wire 中定义 P3 所需的「归一化 AgentEvent」事件契约，配套测试。

**Architecture:** 三步：① 把 `WsMessage` 校验测试迁到 wire（让 wire 有测试覆盖）；② server 依赖 wire、改从 wire 导入 `WsMessage`，删除重复的 `wsSchemas.ts` 与其测试；③ 在 wire 新增 `agentEvent.ts` 定义归一化事件判别联合（spec 第 3.2 节超集），含测试。最后把 wire 纳入 `test:all` 并把各包测试脚本限定为只扫 `src`（修掉 dist 编译副本被重复执行的隐患）。

**Tech Stack:** TypeScript、Zod v3、vitest、pnpm workspace。

---

## 背景事实（执行者必读）

- `packages/server/src/wsSchemas.ts`(116 行) 与 `packages/wire/src/messages.ts`(137 行) **逐字节等价**（仅缩进风格不同），是协议三处分裂之一。wire 版是规范版。
- `wsSchemas` 在 server 仅两处引用：`messageHandler.ts:12`（`import { WsMessage }`）与 `wsSchemas.test.ts:2`。server 的 `package.json` `exports` 未暴露 wsSchemas，可安全删除。
- server **当前不依赖** `@pocket-code/wire`（需加 `workspace:*`）。daemon 已同时依赖 server 与 wire，无循环。
- wire 有 `vitest` devDep 但**无测试文件**，故 `pnpm --filter @pocket-code/wire test`（`vitest run`）当前会因 "No test files" 失败——这正是 P1 把 wire 排除在 `test:all` 之外的原因；P2 加测试后纳入。
- 仓库已设 `.npmrc node-linker=hoisted`（P1），workspace 包互相解析正常；server tsconfig `moduleResolution: bundler`，导入 `@pocket-code/wire` 走其 `main: dist/index.js` / `types: dist/index.d.ts`，**前提是 wire 已构建**（`pnpm build` 按拓扑序先构建 wire）。
- 已知隐患（P2 一并修）：各包 `test` 脚本是 `vitest run`，构建后 `dist/` 里有编译出的 `*.test.js` 副本，vitest 会连 `dist` 一起扫，导致测试数翻倍且可能跑到陈旧副本。改为 `vitest run src` 只扫源码即可。
- 服务端当前出站事件类型（供 AgentEvent 设计参考，已枚举）：`text-delta / reasoning-delta / tool-call / tool-result / file-changed / done / error / usage / model-selected`（流式 agent 事件）+ `auth / session / file-list / file-content / sessions-list / session-deleted / project-workspace-deleted / quota`（控制/RPC 响应）。**P2 只定义流式 agent 事件的归一化契约**；控制/RPC 响应 schema 留待 P3「被真正消费时」再加（避免再造无人引用的死 schema）。

## 文件结构（本计划涉及）

- 新建：`packages/wire/src/messages.test.ts`（迁自 server 的 wsSchemas.test.ts）
- 新建：`packages/wire/src/agentEvent.ts`（归一化 AgentEvent 定义）
- 新建：`packages/wire/src/agentEvent.test.ts`（AgentEvent 测试）
- 修改：`packages/wire/src/index.ts`（导出 agentEvent）
- 修改：`packages/wire/package.json`（test 脚本 → `vitest run src`）
- 修改：`packages/server/package.json`（加 `@pocket-code/wire` 依赖 + test 脚本 → `vitest run src`）
- 修改：`packages/server/src/messageHandler.ts:12`（导入源改为 `@pocket-code/wire`）
- 删除：`packages/server/src/wsSchemas.ts`、`packages/server/src/wsSchemas.test.ts`
- 修改：`packages/daemon/package.json`、`packages/relay/package.json`（test 脚本 → `vitest run src`）
- 修改：`package.json`（根，`test:all` 纳入 wire）

> 所有命令均在仓库根目录 `/Users/worsher/code/self/pocket-code` 执行。

---

### Task 1: 把 WsMessage 校验测试迁移到 wire

**Files:**
- Create: `packages/wire/src/messages.test.ts`
- Modify: `packages/wire/package.json`（test 脚本）

- [ ] **Step 1: 创建 wire 的 messages 测试（迁自 server，导入源改为本地 ./messages.js）**

创建 `packages/wire/src/messages.test.ts`，内容：

```typescript
import { describe, it, expect } from "vitest";
import { WsMessage } from "./messages.js";

describe("wire — WsMessage validation", () => {
  // ── Valid messages ──

  it("should accept valid register message", () => {
    const result = WsMessage.safeParse({ type: "register", deviceId: "abc123" });
    expect(result.success).toBe(true);
  });

  it("should accept valid init message", () => {
    const result = WsMessage.safeParse({
      type: "init",
      token: "jwt-token",
      sessionId: "sess-1",
      model: "deepseek-v3",
    });
    expect(result.success).toBe(true);
  });

  it("should accept valid message with images", () => {
    const result = WsMessage.safeParse({
      type: "message",
      content: "analyze this",
      images: [{ base64: "abc", mimeType: "image/png" }],
    });
    expect(result.success).toBe(true);
  });

  it("should accept valid abort message", () => {
    const result = WsMessage.safeParse({ type: "abort" });
    expect(result.success).toBe(true);
  });

  it("should accept valid tool-exec message", () => {
    const result = WsMessage.safeParse({
      type: "tool-exec",
      toolName: "readFile",
      args: { path: "test.txt" },
      callId: "call-1",
    });
    expect(result.success).toBe(true);
  });

  // ── Invalid messages ──

  it("should reject unknown message type", () => {
    const result = WsMessage.safeParse({ type: "unknown-type" });
    expect(result.success).toBe(false);
  });

  it("should reject register without deviceId", () => {
    const result = WsMessage.safeParse({ type: "register" });
    expect(result.success).toBe(false);
  });

  it("should reject register with empty deviceId", () => {
    const result = WsMessage.safeParse({ type: "register", deviceId: "" });
    expect(result.success).toBe(false);
  });

  it("should reject message without content", () => {
    const result = WsMessage.safeParse({ type: "message" });
    expect(result.success).toBe(false);
  });

  it("should reject message with empty content", () => {
    const result = WsMessage.safeParse({ type: "message", content: "" });
    expect(result.success).toBe(false);
  });

  it("should reject message with too many images", () => {
    const images = Array.from({ length: 11 }, () => ({
      base64: "abc",
      mimeType: "image/png",
    }));
    const result = WsMessage.safeParse({
      type: "message",
      content: "test",
      images,
    });
    expect(result.success).toBe(false);
  });

  it("should reject tool-exec without toolName", () => {
    const result = WsMessage.safeParse({
      type: "tool-exec",
      args: {},
    });
    expect(result.success).toBe(false);
  });

  it("should reject non-object input", () => {
    const result = WsMessage.safeParse("not an object");
    expect(result.success).toBe(false);
  });

  it("should reject null input", () => {
    const result = WsMessage.safeParse(null);
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: 把 wire 的 test 脚本限定为只扫 src**

把 `packages/wire/package.json` 中：

```json
    "test": "vitest run"
```

替换为：

```json
    "test": "vitest run src"
```

- [ ] **Step 3: 运行 wire 测试，确认 14 个全过**

Run: `pnpm --filter @pocket-code/wire test`
Expected: PASS —— `14 passed`（1 个测试文件 `src/messages.test.ts`，不含任何 dist 副本）。

- [ ] **Step 4: 提交**

```bash
git add packages/wire/src/messages.test.ts packages/wire/package.json
git commit -m "test(wire): 迁入 WsMessage 校验测试并限定 vitest 只扫 src"
```

---

### Task 2: server 改用 wire 的 WsMessage，删除重复 wsSchemas

**Files:**
- Modify: `packages/server/package.json`（加 wire 依赖）
- Modify: `packages/server/src/messageHandler.ts:12`
- Delete: `packages/server/src/wsSchemas.ts`、`packages/server/src/wsSchemas.test.ts`

- [ ] **Step 1: 给 server 加 `@pocket-code/wire` 依赖**

把 `packages/server/package.json` 的 `dependencies` 段第一行：

```json
  "dependencies": {
    "@ai-sdk/anthropic": "^1.2.0",
```

替换为（在最前面新增 wire 依赖）：

```json
  "dependencies": {
    "@pocket-code/wire": "workspace:*",
    "@ai-sdk/anthropic": "^1.2.0",
```

- [ ] **Step 2: 安装以建立 workspace 链接**

Run: `pnpm install`
Expected: 安装完成，`@pocket-code/wire` 链接进 server。若出现交互式 "removed and reinstalled" 提示属正常。

- [ ] **Step 3: messageHandler 改从 wire 导入 WsMessage**

把 `packages/server/src/messageHandler.ts` 第 12 行：

```typescript
import { WsMessage } from "./wsSchemas.js";
```

替换为：

```typescript
import { WsMessage } from "@pocket-code/wire";
```

- [ ] **Step 4: 删除 server 里重复的 wsSchemas 源与测试**

Run: `git rm packages/server/src/wsSchemas.ts packages/server/src/wsSchemas.test.ts`
Expected: 两文件被删除并暂存。

- [ ] **Step 5: 构建并测试 server（依赖 wire 先构建）**

Run: `pnpm build`
Expected: wire→server→daemon→relay 全部构建成功（server 现从已构建的 wire 解析 `WsMessage` 类型）。

Run: `pnpm --filter @pocket-code/server test`
Expected: PASS —— server 测试全过（不再含 wsSchemas.test；WsMessage 校验已在 wire 覆盖）。注意若未先 `pnpm build` 直接测，旧 `dist/wsSchemas.test.js` 副本可能残留——本步已先 build，Task 4 会把 server 测试限定为只扫 src 彻底消除该隐患。

- [ ] **Step 6: 提交**

```bash
git add packages/server/package.json packages/server/src/messageHandler.ts pnpm-lock.yaml
git commit -m "refactor(server): 改用 @pocket-code/wire 的 WsMessage，删除重复 wsSchemas"
```

---

### Task 3: 在 wire 定义归一化 AgentEvent

**Files:**
- Create: `packages/wire/src/agentEvent.ts`
- Create: `packages/wire/src/agentEvent.test.ts`
- Modify: `packages/wire/src/index.ts`（导出）

- [ ] **Step 1: 创建归一化 AgentEvent 定义**

创建 `packages/wire/src/agentEvent.ts`，内容：

```typescript
// ── Normalized Agent Event Protocol ───────────────────────
// App 唯一消费的事件契约，不关心由谁产生：DelegatedCliAgent(包装
// claude-code/codex/gemini) 或 in-app BuiltinAgent loop。各 adapter
// 把原生输出归一化到此判别联合。详见 spec 第 3.2 节。

import { z } from "zod";

export const TextDeltaEvent = z.object({
  type: z.literal("text-delta"),
  text: z.string(),
});

export const ReasoningDeltaEvent = z.object({
  type: z.literal("reasoning-delta"),
  text: z.string(),
});

export const ToolCallEvent = z.object({
  type: z.literal("tool-call"),
  callId: z.string(),
  name: z.string(),
  args: z.record(z.unknown()),
});

export const ToolResultEvent = z.object({
  type: z.literal("tool-result"),
  callId: z.string(),
  result: z.unknown(),
  isError: z.boolean().optional(),
});

export const FileChangedEvent = z.object({
  type: z.literal("file-changed"),
  path: z.string(),
  changeType: z.enum(["created", "modified", "deleted"]),
  oldContent: z.string().optional(),
  newContent: z.string().optional(),
});

export const CommandOutputEvent = z.object({
  type: z.literal("command-output"),
  callId: z.string(),
  chunk: z.string(),
  stream: z.enum(["stdout", "stderr"]),
});

export const ProcessStartedEvent = z.object({
  type: z.literal("process-started"),
  processId: z.string(),
  command: z.string(),
  cwd: z.string().optional(),
});

export const ProcessExitedEvent = z.object({
  type: z.literal("process-exited"),
  processId: z.string(),
  exitCode: z.number().int(),
});

export const PreviewAvailableEvent = z.object({
  type: z.literal("preview-available"),
  url: z.string(),
  source: z.enum(["dev-server", "static"]),
});

export const ModelSelectedEvent = z.object({
  type: z.literal("model-selected"),
  modelKey: z.string(),
  reason: z.string().optional(),
});

export const UsageEvent = z.object({
  type: z.literal("usage"),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});

export const DoneEvent = z.object({
  type: z.literal("done"),
});

export const ErrorEvent = z.object({
  type: z.literal("error"),
  message: z.string(),
  code: z.string().optional(),
});

/** 判别联合：App 渲染层只消费此契约 */
export const AgentEvent = z.discriminatedUnion("type", [
  TextDeltaEvent,
  ReasoningDeltaEvent,
  ToolCallEvent,
  ToolResultEvent,
  FileChangedEvent,
  CommandOutputEvent,
  ProcessStartedEvent,
  ProcessExitedEvent,
  PreviewAvailableEvent,
  ModelSelectedEvent,
  UsageEvent,
  DoneEvent,
  ErrorEvent,
]);

export type AgentEventType = z.infer<typeof AgentEvent>;
```

- [ ] **Step 2: 从 wire 的 index 导出**

在 `packages/wire/src/index.ts` 末尾（第 55 行 `} from "./relay.js";` 之后）追加：

```typescript

// Normalized agent event protocol (consumed by the App's render layer)
export {
  TextDeltaEvent,
  ReasoningDeltaEvent,
  ToolCallEvent,
  ToolResultEvent,
  FileChangedEvent,
  CommandOutputEvent,
  ProcessStartedEvent,
  ProcessExitedEvent,
  PreviewAvailableEvent,
  ModelSelectedEvent,
  UsageEvent,
  DoneEvent,
  ErrorEvent,
  AgentEvent,
  type AgentEventType,
} from "./agentEvent.js";
```

- [ ] **Step 3: 创建 AgentEvent 测试**

创建 `packages/wire/src/agentEvent.test.ts`，内容：

```typescript
import { describe, it, expect } from "vitest";
import { AgentEvent } from "./agentEvent.js";

describe("wire — AgentEvent validation", () => {
  it("accepts text-delta", () => {
    expect(AgentEvent.safeParse({ type: "text-delta", text: "hi" }).success).toBe(true);
  });

  it("accepts tool-call with args record", () => {
    const r = AgentEvent.safeParse({
      type: "tool-call",
      callId: "c1",
      name: "runCommand",
      args: { command: "ls" },
    });
    expect(r.success).toBe(true);
  });

  it("accepts tool-result with isError omitted", () => {
    expect(
      AgentEvent.safeParse({ type: "tool-result", callId: "c1", result: { ok: 1 } }).success
    ).toBe(true);
  });

  it("accepts file-changed with valid changeType", () => {
    const r = AgentEvent.safeParse({
      type: "file-changed",
      path: "src/a.ts",
      changeType: "modified",
      oldContent: "a",
      newContent: "b",
    });
    expect(r.success).toBe(true);
  });

  it("rejects file-changed with invalid changeType", () => {
    const r = AgentEvent.safeParse({
      type: "file-changed",
      path: "src/a.ts",
      changeType: "renamed",
    });
    expect(r.success).toBe(false);
  });

  it("accepts command-output with stream enum", () => {
    const r = AgentEvent.safeParse({
      type: "command-output",
      callId: "c1",
      chunk: "line\n",
      stream: "stdout",
    });
    expect(r.success).toBe(true);
  });

  it("accepts preview-available", () => {
    const r = AgentEvent.safeParse({
      type: "preview-available",
      url: "http://localhost:3000",
      source: "dev-server",
    });
    expect(r.success).toBe(true);
  });

  it("accepts process-started / process-exited", () => {
    expect(
      AgentEvent.safeParse({ type: "process-started", processId: "p1", command: "npm run dev" })
        .success
    ).toBe(true);
    expect(
      AgentEvent.safeParse({ type: "process-exited", processId: "p1", exitCode: 0 }).success
    ).toBe(true);
  });

  it("accepts usage with non-negative ints", () => {
    expect(
      AgentEvent.safeParse({ type: "usage", inputTokens: 10, outputTokens: 20 }).success
    ).toBe(true);
  });

  it("accepts done and error", () => {
    expect(AgentEvent.safeParse({ type: "done" }).success).toBe(true);
    expect(AgentEvent.safeParse({ type: "error", message: "boom" }).success).toBe(true);
  });

  it("rejects unknown event type", () => {
    expect(AgentEvent.safeParse({ type: "totally-unknown" }).success).toBe(false);
  });

  it("rejects tool-call missing name", () => {
    expect(
      AgentEvent.safeParse({ type: "tool-call", callId: "c1", args: {} }).success
    ).toBe(false);
  });
});
```

- [ ] **Step 4: 构建 wire 并运行测试**

Run: `pnpm --filter @pocket-code/wire build && pnpm --filter @pocket-code/wire test`
Expected: 构建成功；测试 PASS —— `src/messages.test.ts`(14) + `src/agentEvent.test.ts`(12) 共 **26 passed**。

- [ ] **Step 5: 提交**

```bash
git add packages/wire/src/agentEvent.ts packages/wire/src/agentEvent.test.ts packages/wire/src/index.ts
git commit -m "feat(wire): 定义归一化 AgentEvent 事件契约(含测试)"
```

---

### Task 4: 收尾——wire 纳入 test:all + 各包测试只扫 src

**Files:**
- Modify: `packages/server/package.json`、`packages/daemon/package.json`、`packages/relay/package.json`（test 脚本）
- Modify: `package.json`（根，test:all 纳入 wire）

- [ ] **Step 1: 把 server/daemon/relay 的 test 脚本限定为只扫 src**

把 `packages/server/package.json`、`packages/daemon/package.json`、`packages/relay/package.json` 三个文件中各自的：

```json
    "test": "vitest run"
```

分别替换为：

```json
    "test": "vitest run src"
```

（注：server 的 test 脚本紧邻 `"test:watch": "vitest"`，只改 `"test"` 这一行，不动 `test:watch`。）

- [ ] **Step 2: 根 test:all 纳入 wire**

把 `package.json`（根）的：

```json
    "test:all": "pnpm --filter @pocket-code/server --filter @pocket-code/daemon --filter @pocket-code/relay test",
```

替换为：

```json
    "test:all": "pnpm --filter @pocket-code/wire --filter @pocket-code/server --filter @pocket-code/daemon --filter @pocket-code/relay test",
```

- [ ] **Step 3: 全链路验证（与 CI 一致）**

Run: `pnpm build && pnpm test:all && pnpm typecheck:app && echo ALL GREEN`
Expected: 末尾打印 `ALL GREEN`。其中 `test:all` 含 wire(26) + server(21，去掉 wsSchemas 后) + daemon(7) + relay(5)，且每个包只跑 `src/` 下测试（这些是去掉 dist 副本翻倍后的真实数；P1 里看到的 daemon 14/relay 10 是被 dist 副本翻倍的旧值）。

- [ ] **Step 4: 提交**

```bash
git add package.json packages/server/package.json packages/daemon/package.json packages/relay/package.json
git commit -m "build: wire 纳入 test:all，各包测试限定只扫 src"
```

---

## Self-Review

**1. Spec coverage（对照 spec 第 3.2 / 7.1 节）：**
- ✅ wire 成为入站协议单一真相源、删除 server 重复 wsSchemas → Task 2
- ✅ 归一化 AgentEvent 契约定义在 wire（spec 3.2 全字段超集）→ Task 3
- ✅ wire 获得测试覆盖并纳入 CI → Task 1 + Task 4
- 注：spec 7.1 的「daemon/relay/app 在边界 safeParse 校验」与「出站控制/RPC 响应 schema」**有意留待 P3**（届时随 AgentSession/适配器一起被真正消费，避免再造无引用的死 schema）。本计划范围聚焦"入站去重 + 事件契约定义"。

**2. Placeholder scan：** 无 TBD/TODO；每个代码步骤含完整可替换文件内容与精确命令、预期输出。

**3. Type consistency：** AgentEvent 各成员 `type` 字面量与 spec 3.2 表一致；`changeType` 用 `enum(["created","modified","deleted"])`、`stream` 用 `enum(["stdout","stderr"])`、`source` 用 `enum(["dev-server","static"])`，与测试用例断言一致；`AgentEvent` 判别联合键为 `type`，与 `WsMessage` 同构。server 导入的 `WsMessage` 来自 `@pocket-code/wire`，与 wire `index.ts` 导出名一致。

**4. 风险：** server 以 `moduleResolution: bundler` 导入 `@pocket-code/wire` 依赖 wire 已构建——Task 2 Step 5 先 `pnpm build`（拓扑序先建 wire）再测 server，已规避。若 server 构建报找不到 wire 类型，检查 `pnpm install` 是否成功建立 workspace 链接（hoisted 下应在根 node_modules）。
