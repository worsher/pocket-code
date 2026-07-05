# P6b App 切归一化 AgentEvent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** server 所有 agent 路径直接产 wire `AgentEvent`（删 StreamEvent 与 bridge），出站控制响应 schema 进 wire，App 拆 useAgent 为传输层/纯 reducer/瘦 hook 三层且云端与 geek 共用同一 reducer。

**Architecture:** 七个任务两条线：服务端线（wire 出站 schema → AI-SDK part 映射器 → 一次性切换 agent.ts/cliRunner/messageHandler 并删 bridge）；App 线（vitest 基建 + 纯函数 chatReducer → serverConnection 传输层 → useAgent 重写为组合层，公开 API 不变）。协议直接切，server 与 App 同时升级。

**Tech Stack:** TypeScript、Zod v3（wire）、Vercel AI SDK ^4.3（fullStream part 自带 `toolCallId`）、vitest、React Native（App 层 type-only 引 wire，零运行时依赖）。

## Global Constraints

- App 对外 API 面（useAgent 返回对象的字段名与语义）**保持不变**，App.tsx 与各 Tab 组件零改动（例外：本计划明确列出的 `hooks/chatReducer.ts` 新文件与 `services/serverConnection.ts` 新文件）。
- App 只 `import type` 从 `@pocket-code/wire` 拿类型（devDependency），**不引入运行时 zod/safeParse**，不碰 Metro 配置。
- 唯一有意的行为变化：tool-result 配对从"toolName+首个无 result"改为 **callId 精确配对**（fallback 保留）；以及修复既有 bug——离线队列重放原发非法 `type:"chat"`，改为合法 `type:"message"`。
- 出站 schema 只固化现运行时字段，不改协议语义；宽松处用 `.passthrough()`。
- 各包测试 `vitest run src`；改 wire 后先 `pnpm --filter @pocket-code/wire build` 再跑下游。
- 提交信息中文、`feat/fix/test/docs(scope):` 前缀。

## 背景事实（执行者必读）

- 仓库根 `/Users/wangfeiran/github/pocket-code`，分支 `refactor/architecture-redesign`。
- wire `AgentEvent`（`packages/wire/src/agentEvent.ts`）关键形状：`tool-call {callId:string, name, args:record}`、`tool-result {callId, result, isError?}`、`file-changed {path, changeType:"created"|"modified"|"deleted", oldContent?, newContent?}`、`usage {inputTokens, outputTokens}`（非负整数）、`error {message, code?}`、`model-selected {modelKey, reason?}`、`done {}`。
- AI SDK ^4.3 fullStream part：`text-delta{textDelta}`、`reasoning{textDelta}`、`tool-call{toolCallId, toolName, args}`、`tool-result{toolCallId, toolName, result}`、`error{error}`。
- gemini CLI stream-json 的 `tool_use` 自带 `tool_id`（`cliRunner.ts:62`）——**原生 callId，无需合成**；旧代码把 `tool_id` 误当 toolName 用（`cliRunner.ts:208`），本次顺势修正。
- `messageHandler.ts` 出站 send 调用点：`auth{token,userId}`、`session{sessionId,projectId,workspace}`、`quota{...getUserQuota()}`（=`{userId,tier,limits,usage}`）、`file-list{path,_reqId,...result}`、`file-content{path,_reqId,...result}`、`sessions-list{sessions}`、`session-deleted{sessionId,success}`、`project-workspace-deleted{projectId,success,error?}`、`error{error}`、tool-exec 的 `tool-result{callId,toolName,result}`（**toolName 将删除**，App 按 callId resolve、未读 toolName）。`syncHandler.ts` 出站：`sync-manifest{commit,parent,files,_reqId}`、`sync-file-content{path,encoding?,content?,error?,_reqId}`。
- `useAgent.ts`（1207 行）现结构：L1-87 类型+sync 过滤；L90-253 状态/refs/重连；L255-563 connect（含 onmessage 大 switch）；L568-628 disconnect/stopStreaming/executeTool；L631-722 file/sync RPC；L725-1056 sendMessage/sendCloudMessage/sendGeekMessage；L1059-1207 editAndResend/loadSession/newSession/effects/return。
- App 无任何 workspace 依赖、无测试基建；`node-linker=hoisted`，给 app 加 `@pocket-code/wire` devDep 后 pnpm 会在 `packages/app/node_modules/@pocket-code/` 建链接，tsc 能解析；type-only import 被编译擦除，Metro 不受影响。
- `RelayClient`（`app/src/services/relayClient.ts`）暴露与 WebSocket 同构的接口：`connect()/send()/close()/readyState/onopen/onmessage/onclose/onerror`。
- 根 `package.json` 的 `test:all` 现为 wire/server/daemon/relay 四包。
- `StreamingPhase` 定义在 `app/src/components/StreamingIndicator`（RN 组件文件）——纯 TS 模块只能 **type-only** 引它，否则 vitest 会加载 react-native。

## 文件结构

- 新建：`packages/wire/src/serverOutbound.ts` + `serverOutbound.test.ts`；修改 `wire/src/index.ts`
- 新建：`packages/server/src/aiSdkEvents.ts` + `aiSdkEvents.test.ts`
- 修改：`packages/server/src/agent.ts`（删 StreamEvent、runAgent 改产 AgentEvent）
- 修改：`packages/server/src/cliRunner.ts`（claude 直传 + gemini 归一化）；新建 `cliRunner.gemini.test.ts`
- 删除：`packages/server/src/cli/bridge.ts`、`packages/server/src/cli/bridge.test.ts`
- 修改：`packages/server/src/messageHandler.ts`（tool-exec 响应形状 + satisfies）、`packages/server/src/sync/syncHandler.ts`（satisfies）
- 修改：`packages/app/package.json`（wire+vitest devDeps、test script）、根 `package.json`（test:all 加 app）
- 新建：`packages/app/src/hooks/chatReducer.ts` + `chatReducer.test.ts`
- 新建：`packages/app/src/services/serverConnection.ts`
- 重写：`packages/app/src/hooks/useAgent.ts`

> 命令均在仓库根执行。Task 3 完成前 server 构建保持绿（Task 2 纯新增）；Task 5 完成前 app typecheck 保持绿。

---

### Task 1: wire 出站 schema（ServerOutbound）

**Files:**
- Create: `packages/wire/src/serverOutbound.ts`、`packages/wire/src/serverOutbound.test.ts`
- Modify: `packages/wire/src/index.ts`

**Interfaces:**
- Consumes: `AgentEvent`（`./agentEvent.js`）。
- Produces: 各控制响应 schema + `ServerOutbound` 联合 + `ServerOutboundType`，供 Task 3 的 `satisfies` 与 App 的 type-only import。

- [ ] **Step 1: 写失败测试** `packages/wire/src/serverOutbound.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { ServerOutbound } from "./serverOutbound.js";

describe("ServerOutbound", () => {
  const valid: unknown[] = [
    { type: "auth", token: "jwt", userId: "u1" },
    { type: "session", sessionId: "s1", projectId: "p1", workspace: "/w" },
    { type: "quota", userId: "u1", tier: "free", limits: {}, usage: {} },
    { type: "file-list", path: ".", _reqId: "r1", success: true, items: [] },
    { type: "file-content", path: "a.ts", success: true, content: "x" },
    { type: "sync-manifest", commit: "abc", parent: null, files: [{ path: "a", status: "M" }], _reqId: "r2" },
    { type: "sync-file-content", path: "a", encoding: "base64", content: "YQ==", _reqId: "r3" },
    { type: "sync-file-content", path: "a", error: "read failed" },
    { type: "sessions-list", sessions: [{ session_id: "s1" }] },
    { type: "session-deleted", sessionId: "s1", success: true },
    { type: "project-workspace-deleted", projectId: "p1", success: false, error: "no sessions" },
    { type: "error", error: "boom" },
    // AgentEvent 成员也是 ServerOutbound
    { type: "text-delta", text: "hi" },
    { type: "tool-result", callId: "c1", result: { ok: true } },
    { type: "done" },
  ];
  it.each(valid.map((v) => [(v as any).type, v]))("accepts %s", (_t, v) => {
    expect(ServerOutbound.safeParse(v).success).toBe(true);
  });

  it("rejects unknown type and missing required fields", () => {
    expect(ServerOutbound.safeParse({ type: "nope" }).success).toBe(false);
    expect(ServerOutbound.safeParse({ type: "auth", token: "jwt" }).success).toBe(false); // 缺 userId
    expect(ServerOutbound.safeParse({ type: "session-deleted", sessionId: "s1" }).success).toBe(false); // 缺 success
  });
});
```

- [ ] **Step 2: 确认失败**

Run: `pnpm --filter @pocket-code/wire test`
Expected: FAIL（serverOutbound.js 不存在）

- [ ] **Step 3: 实现** `packages/wire/src/serverOutbound.ts`：

```ts
// ── 出站消息 schema(server → App) ───────────────────────────
// P6b:固化 messageHandler/syncHandler 现有出站响应的契约。字段以现
// 运行时实际输出为准,不改协议语义;工具结果展开处用 passthrough。
// 消费者:server 构造处 satisfies 类型约束 + App 的 import type。

import { z } from "zod";
import { AgentEvent } from "./agentEvent.js";

export const AuthMsg = z.object({
  type: z.literal("auth"),
  token: z.string(),
  userId: z.string(),
});

export const SessionMsg = z.object({
  type: z.literal("session"),
  sessionId: z.string(),
  projectId: z.string(),
  workspace: z.string(),
});

export const QuotaMsg = z.object({
  type: z.literal("quota"),
  userId: z.string(),
  tier: z.string(),
  limits: z.record(z.unknown()),
  usage: z.record(z.unknown()),
});

export const FileListMsg = z
  .object({
    type: z.literal("file-list"),
    path: z.string(),
    _reqId: z.string().optional(),
    success: z.boolean().optional(),
    items: z.array(z.unknown()).optional(),
    error: z.string().optional(),
  })
  .passthrough();

export const FileContentMsg = z
  .object({
    type: z.literal("file-content"),
    path: z.string(),
    _reqId: z.string().optional(),
    success: z.boolean().optional(),
    content: z.string().optional(),
    error: z.string().optional(),
  })
  .passthrough();

export const SyncManifestMsg = z.object({
  type: z.literal("sync-manifest"),
  commit: z.string(),
  parent: z.string().nullable().optional(),
  files: z.array(z.object({ path: z.string(), status: z.string() }).passthrough()),
  _reqId: z.string().optional(),
});

export const SyncFileContentMsg = z.object({
  type: z.literal("sync-file-content"),
  path: z.string(),
  encoding: z.literal("base64").optional(),
  content: z.string().optional(),
  error: z.string().optional(),
  _reqId: z.string().optional(),
});

export const SessionsListMsg = z.object({
  type: z.literal("sessions-list"),
  sessions: z.array(z.record(z.unknown())),
});

export const SessionDeletedMsg = z.object({
  type: z.literal("session-deleted"),
  sessionId: z.string(),
  success: z.boolean(),
});

export const ProjectWorkspaceDeletedMsg = z.object({
  type: z.literal("project-workspace-deleted"),
  projectId: z.string(),
  success: z.boolean(),
  error: z.string().optional(),
});

export const ServerErrorMsg = z.object({
  type: z.literal("error"),
  error: z.string(),
});

/** server → App 的一切出站消息(流式 AgentEvent ∪ 控制响应) */
export const ServerOutbound = z.union([
  AgentEvent,
  AuthMsg,
  SessionMsg,
  QuotaMsg,
  FileListMsg,
  FileContentMsg,
  SyncManifestMsg,
  SyncFileContentMsg,
  SessionsListMsg,
  SessionDeletedMsg,
  ProjectWorkspaceDeletedMsg,
  ServerErrorMsg,
]);
export type ServerOutboundType = z.infer<typeof ServerOutbound>;
```

`packages/wire/src/index.ts` 末尾追加：

```ts
// Server outbound responses (P6b: control-response contracts)
export {
  AuthMsg,
  SessionMsg,
  QuotaMsg,
  FileListMsg,
  FileContentMsg,
  SyncManifestMsg,
  SyncFileContentMsg,
  SessionsListMsg,
  SessionDeletedMsg,
  ProjectWorkspaceDeletedMsg,
  ServerErrorMsg,
  ServerOutbound,
  type ServerOutboundType,
} from "./serverOutbound.js";
```

- [ ] **Step 4: 确认通过并构建**

Run: `pnpm --filter @pocket-code/wire test && pnpm --filter @pocket-code/wire build`
Expected: 全 PASS，构建零错误

- [ ] **Step 5: 提交**

```bash
git add packages/wire/src/serverOutbound.ts packages/wire/src/serverOutbound.test.ts packages/wire/src/index.ts
git commit -m "feat(wire): 出站控制响应 schema + ServerOutbound 联合(P6b 契约固化)"
```

---

### Task 2: server AI-SDK part → AgentEvent 映射器

**Files:**
- Create: `packages/server/src/aiSdkEvents.ts`、`packages/server/src/aiSdkEvents.test.ts`

**Interfaces:**
- Produces: `mapAiSdkPart(part: AiStreamPartLike): AgentEventType[]`、`AiStreamPartLike`。Task 3 的 agent.ts 循环使用。纯新增，不碰现有文件。

- [ ] **Step 1: 写失败测试** `packages/server/src/aiSdkEvents.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { AgentEvent } from "@pocket-code/wire";
import { mapAiSdkPart } from "./aiSdkEvents.js";

describe("mapAiSdkPart", () => {
  it("maps text-delta / reasoning", () => {
    expect(mapAiSdkPart({ type: "text-delta", textDelta: "hi" })).toEqual([
      { type: "text-delta", text: "hi" },
    ]);
    expect(mapAiSdkPart({ type: "reasoning", textDelta: "think" })).toEqual([
      { type: "reasoning-delta", text: "think" },
    ]);
  });

  it("maps tool-call with callId", () => {
    const evs = mapAiSdkPart({
      type: "tool-call", toolCallId: "tc1", toolName: "readFile", args: { path: "a.ts" },
    });
    expect(evs).toEqual([
      { type: "tool-call", callId: "tc1", name: "readFile", args: { path: "a.ts" } },
    ]);
  });

  it("maps tool-result and derives file-changed for writeFile/editFile success", () => {
    const evs = mapAiSdkPart({
      type: "tool-result", toolCallId: "tc2", toolName: "writeFile",
      result: { success: true, path: "src/a.ts", isNew: true },
    });
    expect(evs[0]).toEqual({
      type: "tool-result", callId: "tc2", result: { success: true, path: "src/a.ts", isNew: true },
    });
    expect(evs[1]).toEqual({ type: "file-changed", path: "src/a.ts", changeType: "created" });
    // editFile 非新建 → modified
    const evs2 = mapAiSdkPart({
      type: "tool-result", toolCallId: "tc3", toolName: "editFile",
      result: { success: true, path: "src/b.ts" },
    });
    expect(evs2[1]).toEqual({ type: "file-changed", path: "src/b.ts", changeType: "modified" });
    // 失败/非文件工具 → 不派生
    expect(mapAiSdkPart({ type: "tool-result", toolCallId: "t", toolName: "writeFile", result: { success: false } })).toHaveLength(1);
    expect(mapAiSdkPart({ type: "tool-result", toolCallId: "t", toolName: "runCommand", result: { success: true } })).toHaveLength(1);
  });

  it("maps error and ignores unknown part types", () => {
    expect(mapAiSdkPart({ type: "error", error: new Error("boom") })).toEqual([
      { type: "error", message: "Error: boom" },
    ]);
    expect(mapAiSdkPart({ type: "step-start" })).toEqual([]);
  });

  it("every produced event passes wire AgentEvent.safeParse", () => {
    const all = [
      ...mapAiSdkPart({ type: "text-delta", textDelta: "x" }),
      ...mapAiSdkPart({ type: "tool-call", toolCallId: "c", toolName: "n", args: {} }),
      ...mapAiSdkPart({ type: "tool-result", toolCallId: "c", toolName: "writeFile", result: { success: true, path: "p" } }),
      ...mapAiSdkPart({ type: "error", error: "e" }),
    ];
    for (const ev of all) expect(AgentEvent.safeParse(ev).success).toBe(true);
  });
});
```

- [ ] **Step 2: 确认失败**

Run: `pnpm --filter @pocket-code/server test src/aiSdkEvents.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现** `packages/server/src/aiSdkEvents.ts`：

```ts
// ── AI-SDK fullStream part → 归一化 AgentEvent ──────────────
// P6b:agent.ts 的 AI-SDK 路径改产 wire AgentEvent,映射逻辑抽成
// 纯函数便于单测。结构化最小类型,不绑 ai 包的泛型。

import type { AgentEventType } from "@pocket-code/wire";

export interface AiStreamPartLike {
  type: string;
  textDelta?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  error?: unknown;
}

export function mapAiSdkPart(part: AiStreamPartLike): AgentEventType[] {
  switch (part.type) {
    case "text-delta":
      return [{ type: "text-delta", text: part.textDelta ?? "" }];
    case "reasoning":
      return [{ type: "reasoning-delta", text: part.textDelta ?? "" }];
    case "tool-call":
      return [
        {
          type: "tool-call",
          callId: part.toolCallId ?? "",
          name: part.toolName ?? "",
          args: (part.args as Record<string, unknown>) ?? {},
        },
      ];
    case "tool-result": {
      const events: AgentEventType[] = [
        { type: "tool-result", callId: part.toolCallId ?? "", result: part.result },
      ];
      // writeFile/editFile 成功 → 派生 file-changed(驱动 App Diff/本地同步)
      const r = part.result as { success?: boolean; path?: string; isNew?: boolean } | undefined;
      if ((part.toolName === "writeFile" || part.toolName === "editFile") && r?.success && r.path) {
        events.push({ type: "file-changed", path: r.path, changeType: r.isNew ? "created" : "modified" });
      }
      return events;
    }
    case "error":
      return [{ type: "error", message: String(part.error) }];
    default:
      return [];
  }
}
```

- [ ] **Step 4: 确认通过**

Run: `pnpm --filter @pocket-code/server test src/aiSdkEvents.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/aiSdkEvents.ts packages/server/src/aiSdkEvents.test.ts
git commit -m "feat(server): AI-SDK fullStream part→AgentEvent 映射器(纯函数+单测)"
```

---

### Task 3: server 切换归一化（删 StreamEvent 与 bridge）

**Files:**
- Modify: `packages/server/src/agent.ts`、`packages/server/src/cliRunner.ts`、`packages/server/src/messageHandler.ts`、`packages/server/src/sync/syncHandler.ts`
- Delete: `packages/server/src/cli/bridge.ts`、`packages/server/src/cli/bridge.test.ts`
- Create: `packages/server/src/cliRunner.gemini.test.ts`

**Interfaces:**
- Consumes: Task 1 `ServerOutboundType`、Task 2 `mapAiSdkPart`/`AiStreamPartLike`、现有 `runCliAgent`（已产 AgentEvent）。
- Produces: `runAgent(session, msg, onEvent: (ev: AgentEventType) => void, signal?, images?)`；`createGeminiLineParser(): (line, onEvent, appendText) => void`（导出供测试）。**全仓自此无 `StreamEvent`。**

- [ ] **Step 1: 先写 gemini 解析失败测试** `packages/server/src/cliRunner.gemini.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { AgentEvent, type AgentEventType } from "@pocket-code/wire";
import { createGeminiLineParser } from "./cliRunner.js";

function collect(lines: string[]): { events: AgentEventType[]; text: string } {
  const parse = createGeminiLineParser();
  const events: AgentEventType[] = [];
  let text = "";
  for (const l of lines) parse(l, (e) => events.push(e), (t) => { text += t; });
  return { events, text };
}

describe("createGeminiLineParser", () => {
  it("maps assistant message to text-delta and accumulates text", () => {
    const { events, text } = collect([
      JSON.stringify({ type: "message", role: "assistant", content: "hello" }),
    ]);
    expect(events).toEqual([{ type: "text-delta", text: "hello" }]);
    expect(text).toBe("hello");
  });

  it("maps tool_use/tool_result with native tool_id as callId", () => {
    const { events } = collect([
      JSON.stringify({ type: "tool_use", tool_name: "read_file", tool_id: "t1", parameters: { path: "a" } }),
      JSON.stringify({ type: "tool_result", tool_id: "t1", status: "success", output: { ok: true } }),
    ]);
    expect(events[0]).toEqual({ type: "tool-call", callId: "t1", name: "read_file", args: { path: "a" } });
    expect(events[1]).toEqual({ type: "tool-result", callId: "t1", result: { ok: true } });
  });

  it("synthesizes callId when tool_id missing and flags error results", () => {
    const { events } = collect([
      JSON.stringify({ type: "tool_use", tool_name: "x", parameters: {} }),
      JSON.stringify({ type: "tool_result", status: "error", output: "boom" }),
    ]);
    expect((events[0] as any).callId).toMatch(/^gm_/);
    expect((events[1] as any).isError).toBe(true);
  });

  it("maps result/error lines to error events; ignores junk", () => {
    const { events } = collect([
      "not json",
      JSON.stringify({ type: "result", status: "error", error: { message: "failed" } }),
      JSON.stringify({ type: "error", error: "bad" }),
    ]);
    expect(events).toEqual([
      { type: "error", message: "failed" },
      { type: "error", message: "bad" },
    ]);
  });

  it("all produced events pass wire AgentEvent.safeParse", () => {
    const { events } = collect([
      JSON.stringify({ type: "message", role: "assistant", content: "a" }),
      JSON.stringify({ type: "tool_use", tool_name: "n", tool_id: "t", parameters: {} }),
      JSON.stringify({ type: "tool_result", tool_id: "t", status: "success", output: {} }),
    ]);
    for (const ev of events) expect(AgentEvent.safeParse(ev).success).toBe(true);
  });
});
```

- [ ] **Step 2: 确认失败**

Run: `pnpm --filter @pocket-code/server test src/cliRunner.gemini.test.ts`
Expected: FAIL（`createGeminiLineParser` 未导出）

- [ ] **Step 3: 改 `agent.ts`**。四处：

① 删除 L145-154 的 `export type StreamEvent = ...` 整块；顶部加 import：

```ts
import type { AgentEventType } from "@pocket-code/wire";
import { mapAiSdkPart, type AiStreamPartLike } from "./aiSdkEvents.js";
```

② `runAgent` 签名：`onEvent: (event: StreamEvent) => void` → `onEvent: (event: AgentEventType) => void`。

③ fullStream 循环（原 L233-265 的 switch 整块）替换为：

```ts
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") fullText += part.textDelta;
      for (const ev of mapAiSdkPart(part as AiStreamPartLike)) onEvent(ev);
    }
```

④ 其余三处发射改为归一化字段：
- model-selected（原 L204）：`onEvent({ type: "model-selected", modelKey: effectiveModelKey, reason: analysis.reason });`
- usage（原 L284-289）：`onEvent({ type: "usage", inputTokens: usage.promptTokens || 0, outputTokens: usage.completionTokens || 0 });`
- catch 中 error（原 L300）：`onEvent({ type: "error", message: err.message });`

- [ ] **Step 4: 改 `cliRunner.ts`**。

① 头部：`import type { AgentSession, StreamEvent } from "./agent.js"` → `import type { AgentSession } from "./agent.js";`；删除 `import { createAgentEventToStreamEvent } from "./cli/bridge.js";`；新增 `import type { AgentEventType } from "@pocket-code/wire";`。

② `runClaudeCodeAgent`：`onEvent: (event: StreamEvent) => void` → `onEvent: (event: AgentEventType) => void`；函数体删掉 bridge，直接透传：

```ts
  const fullText = await runCliAgent(
    claudeCodeAdapter,
    userMessage,
    { workspace: session.workspace, customPrompt: session.customPrompt },
    onEvent,
    signal
  );
```

（同步更新函数 JSDoc：去掉"桥接回旧 StreamEvent"表述。）

③ `runGeminiCliAgent`：`onEvent` 类型同样改 `AgentEventType`；两处内联错误发射改字段：`{ type: "error", error: ... }` → `{ type: "error", message: ... }`（`close` 非零码与 spawn `error` 两处）。

④ 把文件底部 `function parseLine(...)` 替换为**有状态工厂**（合成 callId 计数）并导出：

```ts
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
```

`runGeminiCliAgent` 内改为在 Promise 外先 `const parseLine = createGeminiLineParser();`，两处调用 `parseLine(line, onEvent, ...)` 不变（签名兼容）。

⑤ 删除 bridge：

```bash
git rm packages/server/src/cli/bridge.ts packages/server/src/cli/bridge.test.ts
```

- [ ] **Step 5: 改 `messageHandler.ts` 与 `syncHandler.ts`**。

① `messageHandler.ts` 头部 import 加：`import type { ServerOutboundType } from "@pocket-code/wire";`（与现有 `WsMessage` 合并 import 亦可）。

② tool-exec case（原 L245-277）三处响应删 `toolName` 字段并加约束，形如：

```ts
              send({ type: "tool-result", callId, result } satisfies ServerOutboundType);
```

（unknown-tool 与 catch 分支同样：`send({ type: "tool-result", callId, result: { success: false, error: ... } } satisfies ServerOutboundType);`）

③ 纯字面量构造的 send 加 `satisfies ServerOutboundType`：`auth`（L96）、`session`（L183）、`session-deleted`（L392）、`project-workspace-deleted`（三处）。带展开的（`quota`/`file-list`/`file-content`/`sessions-list`）保持原样（passthrough schema 覆盖，不强行改写）。

④ `syncHandler.ts` 两个 send 字面量（`sync-manifest`、`sync-file-content` 两处）加 `satisfies ServerOutboundType`（头部 `import type { ServerOutboundType } from "@pocket-code/wire";`）。若 `ChangedFile` 的 `status` 字段类型与 schema 不合（枚举 vs string），以**现实现输出**为准调整 schema 而非改 syncHandler。

- [ ] **Step 6: 全量验证**

Run: `pnpm --filter @pocket-code/server build && pnpm --filter @pocket-code/server test && grep -rn "StreamEvent" packages/server/src/ | grep -v test; echo "grep-exit=$?"`
Expected: 构建零错误；全部测试 PASS（含新 gemini 测试；bridge 测试已删）；grep 无命中（exit=1）

- [ ] **Step 7: 提交**

```bash
git add -A packages/server/src
git commit -m "feat(server): 全路径事件归一化为 AgentEvent,删 StreamEvent 与 cli/bridge(P6b 协议切换)"
```

---

### Task 4: App 测试基建 + chatReducer（纯函数）

**Files:**
- Modify: `packages/app/package.json`（devDeps + test script）、根 `package.json`（test:all）
- Create: `packages/app/src/hooks/chatReducer.ts`、`packages/app/src/hooks/chatReducer.test.ts`

**Interfaces:**
- Produces（Task 6 消费，签名精确）：
  - `interface ToolCall { callId?: string; toolName: string; args: Record<string, unknown>; result?: unknown }`
  - `interface Message { id: string; role: "user" | "assistant"; content: string; thinking?: string; toolCalls?: ToolCall[]; images?: ImageAttachment[]; timestamp: number; pending?: boolean; modelUsed?: string }`
  - `interface ImageAttachment { uri: string; base64: string; mimeType: "image/jpeg" | "image/png" }`
  - `applyAgentEvent(messages: Message[], ev: AgentEventType): Message[]`（无变化时返回原引用）
  - `phaseFor(ev: AgentEventType): StreamingPhase | null`（null=不改 phase）

- [ ] **Step 1: 基建**。`packages/app/package.json`：`devDependencies` 加 `"@pocket-code/wire": "workspace:*"`、`"vitest": "^3.2.4"`（与其他包版本一致，以 `grep '"vitest"' packages/wire/package.json` 为准）；`scripts` 加 `"test": "vitest run src"`。根 `package.json` 的 `test:all` 改为在现有四包后追加 ` --filter @pocket-code/app`。然后 `pnpm install`，确认 `ls packages/app/node_modules/@pocket-code/` 出现 `wire`。

- [ ] **Step 2: 写失败测试** `packages/app/src/hooks/chatReducer.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { applyAgentEvent, phaseFor, type Message } from "./chatReducer";

const base = (over: Partial<Message> = {}): Message[] => [
  { id: "1", role: "user", content: "hi", timestamp: 1 },
  { id: "2", role: "assistant", content: "", toolCalls: [], timestamp: 2, ...over },
];

describe("applyAgentEvent", () => {
  it("appends text-delta to last assistant content", () => {
    const out = applyAgentEvent(base(), { type: "text-delta", text: "he" });
    const out2 = applyAgentEvent(out, { type: "text-delta", text: "llo" });
    expect(out2[1].content).toBe("hello");
    expect(out2[0]).toBe(out[0]); // 未动的消息保持引用
  });

  it("appends reasoning-delta to thinking", () => {
    const out = applyAgentEvent(base(), { type: "reasoning-delta", text: "mm" });
    expect(out[1].thinking).toBe("mm");
  });

  it("records tool-call and pairs tool-result by callId (并发同名工具不错配)", () => {
    let msgs = base();
    msgs = applyAgentEvent(msgs, { type: "tool-call", callId: "c1", name: "readFile", args: { path: "a" } });
    msgs = applyAgentEvent(msgs, { type: "tool-call", callId: "c2", name: "readFile", args: { path: "b" } });
    msgs = applyAgentEvent(msgs, { type: "tool-result", callId: "c2", result: "B" });
    const tcs = msgs[1].toolCalls!;
    expect(tcs[0].result).toBeUndefined();
    expect(tcs[1].result).toBe("B");
  });

  it("falls back to first unresolved call when callId unmatched", () => {
    let msgs = base();
    msgs = applyAgentEvent(msgs, { type: "tool-call", callId: "c1", name: "x", args: {} });
    msgs = applyAgentEvent(msgs, { type: "tool-result", callId: "zz", result: 1 });
    expect(msgs[1].toolCalls![0].result).toBe(1);
  });

  it("sets modelUsed on model-selected and appends error text", () => {
    let msgs = base();
    msgs = applyAgentEvent(msgs, { type: "model-selected", modelKey: "deepseek-v3", reason: "simple" });
    expect(msgs[1].modelUsed).toBe("deepseek-v3");
    msgs = applyAgentEvent(msgs, { type: "error", message: "boom" });
    expect(msgs[1].content).toContain("Error: boom");
  });

  it("returns same reference for ignored events and when last is not assistant", () => {
    const msgs = base();
    expect(applyAgentEvent(msgs, { type: "done" })).toBe(msgs);
    expect(applyAgentEvent(msgs, { type: "usage", inputTokens: 1, outputTokens: 2 })).toBe(msgs);
    expect(applyAgentEvent(msgs, { type: "file-changed", path: "a", changeType: "modified" })).toBe(msgs);
    const userOnly: Message[] = [{ id: "1", role: "user", content: "x", timestamp: 1 }];
    expect(applyAgentEvent(userOnly, { type: "text-delta", text: "y" })).toBe(userOnly);
  });
});

describe("phaseFor", () => {
  it("maps events to streaming phases", () => {
    expect(phaseFor({ type: "reasoning-delta", text: "" })).toBe("thinking");
    expect(phaseFor({ type: "text-delta", text: "" })).toBe("generating");
    expect(phaseFor({ type: "tool-call", callId: "c", name: "n", args: {} })).toBe("tool-calling");
    expect(phaseFor({ type: "tool-result", callId: "c", result: 1 })).toBe("generating");
    expect(phaseFor({ type: "done" })).toBe("idle");
    expect(phaseFor({ type: "error", message: "e" })).toBe("idle");
    expect(phaseFor({ type: "usage", inputTokens: 0, outputTokens: 0 })).toBeNull();
  });
});
```

- [ ] **Step 3: 确认失败**

Run: `pnpm --filter @pocket-code/app test`
Expected: FAIL（chatReducer 不存在）

- [ ] **Step 4: 实现** `packages/app/src/hooks/chatReducer.ts`：

```ts
// ── 归一化 AgentEvent → 消息列表 reducer(纯函数,零 RN 依赖) ──
// P6b:云端与 geek 两条路径共用的 UI 更新逻辑。只更新末尾 assistant
// 消息;无变化时返回原引用(避免无谓渲染)。phase 推导同理。

import type { AgentEventType } from "@pocket-code/wire";
import type { StreamingPhase } from "../components/StreamingIndicator";

export interface ImageAttachment {
  uri: string;
  base64: string;
  mimeType: "image/jpeg" | "image/png";
}

export interface ToolCall {
  /** 归一化事件的 callId;历史旧存档无此字段 */
  callId?: string;
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  images?: ImageAttachment[];
  timestamp: number;
  pending?: boolean;
  modelUsed?: string;
}

/** 更新末尾 assistant 消息;末尾不是 assistant 则原样返回。 */
function updateLastAssistant(
  messages: Message[],
  update: (m: Message) => Message
): Message[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return messages;
  const next = messages.slice(0, -1);
  next.push(update(last));
  return next;
}

export function applyAgentEvent(messages: Message[], ev: AgentEventType): Message[] {
  switch (ev.type) {
    case "text-delta":
      return updateLastAssistant(messages, (m) => ({ ...m, content: m.content + ev.text }));
    case "reasoning-delta":
      return updateLastAssistant(messages, (m) => ({ ...m, thinking: (m.thinking || "") + ev.text }));
    case "tool-call":
      return updateLastAssistant(messages, (m) => ({
        ...m,
        toolCalls: [...(m.toolCalls || []), { callId: ev.callId, toolName: ev.name, args: ev.args }],
      }));
    case "tool-result":
      return updateLastAssistant(messages, (m) => {
        const toolCalls = [...(m.toolCalls || [])];
        // callId 精确配对;找不到再回退"首个未完成"(兼容合成/缺失 callId)
        let idx = toolCalls.findIndex((t) => t.callId === ev.callId && t.result === undefined);
        if (idx === -1) idx = toolCalls.findIndex((t) => t.result === undefined);
        if (idx === -1) return m;
        toolCalls[idx] = { ...toolCalls[idx], result: ev.result };
        return { ...m, toolCalls };
      });
    case "model-selected":
      return updateLastAssistant(messages, (m) => ({ ...m, modelUsed: ev.modelKey }));
    case "error":
      return updateLastAssistant(messages, (m) => ({ ...m, content: m.content + `\n\nError: ${ev.message}` }));
    // usage/done/file-changed/command-output/process-*/preview-available:
    // 无消息列表内的 UI 消费者(done 的副作用在 hook 层),显式忽略。
    default:
      return messages;
  }
}

/** 事件 → streaming phase;null 表示不改变当前 phase。 */
export function phaseFor(ev: AgentEventType): StreamingPhase | null {
  switch (ev.type) {
    case "reasoning-delta":
      return "thinking";
    case "text-delta":
      return "generating";
    case "tool-call":
      return "tool-calling";
    case "tool-result":
      return "generating";
    case "done":
    case "error":
      return "idle";
    default:
      return null;
  }
}
```

- [ ] **Step 5: 确认通过**

Run: `pnpm --filter @pocket-code/app test && pnpm typecheck:app`
Expected: 测试全 PASS；tsc 零错误

- [ ] **Step 6: 提交**

```bash
git add packages/app/package.json package.json pnpm-lock.yaml packages/app/src/hooks/chatReducer.ts packages/app/src/hooks/chatReducer.test.ts
git commit -m "feat(app): chatReducer 纯函数(AgentEvent→消息列表,callId 精确配对)+vitest 基建"
```

---

### Task 5: App serverConnection 传输层

**Files:**
- Create: `packages/app/src/services/serverConnection.ts`

**Interfaces:**
- Consumes: `RelayClient`（现有）、`import type { AgentEventType } from "@pocket-code/wire"`。
- Produces（Task 6 消费）：

```ts
export interface ConnectionConfig {
  getServerUrl(): string;
  isRelayMode(): boolean;
  getRelayOptions(): { machineId: string; deviceId: string; token?: string };
  getAuthToken(): string | undefined;
  getDeviceId(): string;
  /** init 消息的业务载荷(sessionId/projectId/model/gitCredentials) */
  buildInitPayload(): Record<string, unknown>;
  /** relay 模式已配对(有 token+machineId)才发 init */
  isRelayPaired(): boolean;
}
export interface ConnectionHandlers {
  onAgentEvent(ev: AgentEventType): void;
  onAuth(token: string, userId: string): void;
  onSession(sessionId: string): void;
  onConnected(): void;
  onDisconnected(): void;
  onAuthError(message: string): void;
  onFileChanged(path: string, changeType: "created" | "modified" | "deleted"): void;
}
export class ServerConnection {
  constructor(config: ConnectionConfig, handlers: ConnectionHandlers);
  connect(): void;                    // 含指数退避自动重连
  disconnect(): void;                 // 主动断开,停止重连
  get isOpen(): boolean;
  sendRaw(obj: Record<string, unknown>): boolean;
  execTool(toolName: string, args: Record<string, unknown>): Promise<unknown>;   // 30s 超时
  listFiles(path?: string): Promise<any>;      // 10s
  readFile(path: string): Promise<any>;        // 10s
  syncPull(sinceCommit?: string): Promise<any>; // 30s
  syncFile(commit: string, path: string): Promise<any>; // 30s
}
```

- [ ] **Step 1: 实现**（传输层为 useAgent 现有代码的搬迁重组，无既有测试基建可依托——本任务以 `typecheck:app` 为门禁，运行时行为由 Task 6 后的真机回归覆盖）。`packages/app/src/services/serverConnection.ts`：

```ts
// ── 服务端连接(传输层,零 React 依赖) ─────────────────────────
// P6b:从 useAgent 抽出——WS/Relay 生命周期、指数退避重连、鉴权握手
// (register→auth→init / relay 免 token init)、_reqId RPC、消息分发。
// 入站流式事件即归一化 AgentEvent(server 已切换,P6b Task 3)。

import { RelayClient } from "./relayClient";
import type { AgentEventType } from "@pocket-code/wire";

export interface ConnectionConfig {
  getServerUrl(): string;
  isRelayMode(): boolean;
  getRelayOptions(): { machineId: string; deviceId: string; token?: string };
  getAuthToken(): string | undefined;
  getDeviceId(): string;
  buildInitPayload(): Record<string, unknown>;
  isRelayPaired(): boolean;
}

export interface ConnectionHandlers {
  onAgentEvent(ev: AgentEventType): void;
  onAuth(token: string, userId: string): void;
  onSession(sessionId: string): void;
  onConnected(): void;
  onDisconnected(): void;
  onAuthError(message: string): void;
  onFileChanged(path: string, changeType: "created" | "modified" | "deleted"): void;
}

/** 归一化流式事件类型集合(据此路由到 onAgentEvent) */
const AGENT_EVENT_TYPES = new Set([
  "text-delta", "reasoning-delta", "tool-call", "tool-result", "file-changed",
  "command-output", "process-started", "process-exited", "preview-available",
  "model-selected", "usage", "done", "error",
]);

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;

export class ServerConnection {
  private ws: WebSocket | RelayClient | null = null;
  private shouldConnect = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  /** _reqId/callId → resolver(RPC 关联:tool-exec 与 file/sync 请求) */
  private resolvers = new Map<string, (result: unknown) => void>();

  constructor(
    private config: ConnectionConfig,
    private handlers: ConnectionHandlers
  ) {}

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  sendRaw(obj: Record<string, unknown>): boolean {
    if (!this.isOpen || !this.ws) return false;
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  connect(): void {
    this.shouldConnect = true;
    this.clearReconnect();
    if (this.isOpen) return;

    const url = this.config.getServerUrl();
    console.log("[Conn] Connecting to:", url, "relay:", this.config.isRelayMode());

    let ws: WebSocket | RelayClient;
    if (this.config.isRelayMode()) {
      const relay = this.config.getRelayOptions();
      ws = new RelayClient({
        relayUrl: url,
        machineId: relay.machineId,
        deviceId: relay.deviceId,
        deviceName: "Pocket Code App",
        token: relay.token,
      });
      ws.connect();
    } else {
      ws = new WebSocket(url);
    }
    this.ws = ws;

    ws.onopen = () => {
      console.log("[Conn] Connected");
      this.reconnectAttempt = 0;
      this.handlers.onConnected();

      if (this.config.isRelayMode()) {
        // relay 模式:daemon 侧 preAuth,已配对则直接 init(不带 token)
        if (this.config.isRelayPaired()) {
          this.sendRaw({ type: "init", ...this.config.buildInitPayload() });
        } else {
          console.log("[Conn] Connected to relay but not paired yet.");
        }
      } else {
        const token = this.config.getAuthToken();
        if (token) {
          this.sendInit(token);
        } else {
          this.sendRaw({ type: "register", deviceId: this.config.getDeviceId() });
        }
      }
    };

    ws.onmessage = (event: MessageEvent<any> | { data: string }) => {
      const data =
        typeof event.data === "string" ? JSON.parse(event.data) : JSON.parse(event.data.toString());
      this.dispatch(data);
    };

    ws.onclose = () => {
      console.log("[Conn] Closed");
      this.handlers.onDisconnected();
      if (this.shouldConnect) this.scheduleReconnect();
    };

    ws.onerror = () => {
      console.error("[Conn] WebSocket error");
      // onerror 后会触发 onclose,由 onclose 统一调度重连
    };
  }

  disconnect(): void {
    this.shouldConnect = false;
    this.clearReconnect();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  private sendInit(token: string): void {
    this.sendRaw({ type: "init", token, ...this.config.buildInitPayload() });
  }

  private dispatch(data: any): void {
    switch (true) {
      case data.type === "auth": {
        this.handlers.onAuth(data.token, data.userId);
        this.sendInit(data.token);
        return;
      }
      case data.type === "session": {
        this.handlers.onSession(data.sessionId);
        return;
      }
      // RPC 响应:_reqId 关联(file-list/file-content/sync-manifest/sync-file-content)
      case data.type === "file-list" || data.type === "file-content" ||
           data.type === "sync-manifest" || data.type === "sync-file-content": {
        const resolver = data._reqId && this.resolvers.get(data._reqId);
        if (resolver) {
          resolver(data);
          this.resolvers.delete(data._reqId);
        }
        return;
      }
      // tool-result:pending execTool(geek RPC)优先按 callId 消化;否则是流式事件
      case data.type === "tool-result": {
        const resolver = data.callId && this.resolvers.get(data.callId);
        if (resolver) {
          resolver(data.result);
          this.resolvers.delete(data.callId);
          return;
        }
        this.handlers.onAgentEvent(data as AgentEventType);
        return;
      }
      case data.type === "error": {
        // 设备 token 被 daemon 拒绝:死 token 重试无意义,停止重连并提示重新配对
        if (typeof data.error === "string" && data.error.includes("Unauthorized")) {
          this.shouldConnect = false;
          this.clearReconnect();
          this.handlers.onAuthError("设备未授权或配对已失效,请在设置中重新配对");
          try { this.ws?.close(); } catch { /* ignore */ }
          return;
        }
        // 其余错误作为归一化 error 事件交给上层(字段名适配:出站 error 用 {error})
        this.handlers.onAgentEvent({ type: "error", message: String(data.error ?? "unknown") });
        return;
      }
      case AGENT_EVENT_TYPES.has(data.type): {
        if (data.type === "file-changed") {
          this.handlers.onFileChanged(data.path, data.changeType);
        }
        this.handlers.onAgentEvent(data as AgentEventType);
        return;
      }
      default:
        return; // machines-list/pair-response 等由设置页的独立连接处理
    }
  }

  // ── RPC helpers(_reqId 请求-响应 + 超时) ──────────────
  private request<T>(payload: Record<string, unknown>, key: string, timeoutMs: number, what: string): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.isOpen) {
        reject(new Error(`WebSocket not connected (${what})`));
        return;
      }
      this.resolvers.set(key, resolve as (r: unknown) => void);
      setTimeout(() => {
        if (this.resolvers.has(key)) {
          this.resolvers.delete(key);
          reject(new Error(`${what} timed out`));
        }
      }, timeoutMs);
      this.sendRaw(payload);
    });
  }

  execTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const callId = `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return this.request({ type: "tool-exec", callId, toolName, args }, callId, 30000, `Tool ${toolName}`);
  }

  listFiles(path: string = "."): Promise<any> {
    const reqId = `fr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return this.request({ type: "list-files", path, _reqId: reqId }, reqId, 10000, "File list");
  }

  readFile(path: string): Promise<any> {
    const reqId = `fr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return this.request({ type: "read-file", path, _reqId: reqId }, reqId, 10000, "File read");
  }

  syncPull(sinceCommit?: string): Promise<any> {
    const reqId = `sp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return this.request({ type: "sync-pull", sinceCommit, _reqId: reqId }, reqId, 30000, "Sync pull");
  }

  syncFile(commit: string, path: string): Promise<any> {
    const reqId = `sf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return this.request({ type: "sync-file", commit, path, _reqId: reqId }, reqId, 30000, "Sync file");
  }

  // ── 重连(指数退避) ────────────────────────────────────
  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldConnect) return;
    this.clearReconnect();
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt), RECONNECT_MAX_MS);
    this.reconnectAttempt += 1;
    console.log(`[Conn] Reconnecting in ${(delay / 1000).toFixed(1)}s`);
    this.reconnectTimer = setTimeout(() => {
      if (this.shouldConnect) this.connect();
    }, delay);
  }
}
```

- [ ] **Step 2: 类型门禁**

Run: `pnpm typecheck:app`
Expected: 零错误（无消费者，仅编译检查）

- [ ] **Step 3: 提交**

```bash
git add packages/app/src/services/serverConnection.ts
git commit -m "feat(app): ServerConnection 传输层(连接/重连/握手/RPC 从 useAgent 抽出)"
```

---

### Task 6: useAgent 重写为瘦组合层

**Files:**
- Rewrite: `packages/app/src/hooks/useAgent.ts`

**Interfaces:**
- Consumes: Task 4 `applyAgentEvent`/`phaseFor`/`Message`/`ToolCall`/`ImageAttachment`；Task 5 `ServerConnection`。
- Produces: 返回对象字段与现版完全一致（见下）；`Message`/`ToolCall`/`ImageAttachment`/`AVAILABLE_MODELS`/`ModelInfo`/`StreamingPhase` 继续从本文件导出（类型转为 re-export）。

**要求（重写时逐条落实）：**

1. **保留的对外导出**：`export type { StreamingPhase }`、`export type { Message, ToolCall, ImageAttachment } from "./chatReducer"`（re-export）、`AVAILABLE_MODELS`、`ModelInfo`、`useAgent`。
2. **返回对象字段不变**：`messages, setMessages, isConnected, isStreaming, streamingPhase, currentToolName, sessionId, authError, needsAutoConnect, connect, disconnect, stopStreaming, sendMessage, editAndResend, loadSession, newSession, requestFileList, requestFileContent, requestSyncPull, requestSyncFile, deleteProjectWorkspace`。
3. **连接**：单例 `ServerConnection`（`useRef` 惰性创建），`ConnectionConfig` 各 getter 读现有 refs（`serverUrlRef`/`workspaceModeRef`/`settingsRef`/`authTokenRef`/`deviceIdRef`）；`buildInitPayload()` 返回 `{ sessionId: sessionIdRef.current, projectId: projectIdRef.current || undefined, model: modelRef.current, gitCredentials: gitCredentialsRef.current?.filter(c => c.token) || [] }`；`getDeviceId` 沿用现逻辑（无则生成并 `updateSettings` 持久化）。
4. **事件接入**（handlers）：
   - `onAgentEvent(ev)`：云端模式下 `setMessages(prev => applyAgentEvent(prev, ev))`；`phaseFor(ev)` 非 null 时 `setStreamingPhase`；`tool-call` 时 `setCurrentToolName(ev.name)` 并记 `callNamesRef.current.set(ev.callId, ev.name)`；`tool-result` 时 `setCurrentToolName(undefined)`，且若 `callNamesRef` 查得名字为 `runCommand` 且 `AppState.currentState !== "active"` 则发本地通知（沿用现文案逻辑）；`done` 时收敛（`setIsStreaming(false)`、存历史 `saveMessages`、后台通知，沿用现逻辑）；`error` 事件已由 reducer 追加文案，只需收敛 streaming 状态。geek 模式下来自服务器的流式事件忽略（geek 的事件走本地适配层，见 6）。
   - `onAuth(token, userId)`：`updateSettings({ authToken: token, userId })` + `authTokenRef.current = token`。
   - `onSession(sessionId)`：`setSessionId`。
   - `onConnected`：`setIsConnected(true)`、`setAuthError(null)`、重放离线队列（**修复**：改发 `{ type: "message", content, model: modelRef.current }`——原 `type:"chat"` 是非法消息）。
   - `onDisconnected`：`setIsConnected(false)`。
   - `onAuthError(msg)`：`setAuthError(msg)`。
   - `onFileChanged(path, changeType)`：沿用现逻辑——`onFileChangedRef.current?.(path, changeType)` + local 模式下 `shouldSyncFile` 过滤后 `readFile` 并 `writeLocalFile`（`SYNC_IGNORE_*` 常量与 `shouldSyncFile` 原样保留在本文件）。
5. **发送**：`sendMessage`/`sendCloudMessage`（经 `conn.sendRaw({type:"message", content, model, images?, customPrompt?})`）/`editAndResend`（cloud 带 `rewindTo`）/离线入队逻辑全部沿用现行为；`stopStreaming` cloud 发 `{type:"abort"}`。
6. **geek 路径**：`sendGeekMessage` 的 `streamChat` 循环结构保留（chatHistory 构建、MAX_STEPS、pendingToolCalls、executeTool 本地/远程回退），但 **UI 更新改为喂 reducer**：
   - `onTextDelta: (t) => emitGeek({ type: "text-delta", text: t })`
   - `onThinking: (t) => emitGeek({ type: "reasoning-delta", text: t })`
   - `onToolCall: (id, name, args) => { pendingToolCalls.push(...); emitGeek({ type: "tool-call", callId: id, name, args: args as Record<string, unknown> }); }`
   - 工具执行完：`emitGeek({ type: "tool-result", callId: tc.id, result })`（错误分支 `result` 为 `{success:false,error}`）
   - `onError: (e) => emitGeek({ type: "error", message: e })`
   - 其中 `emitGeek = (ev: AgentEventType) => { setMessages(prev => applyAgentEvent(prev, ev)); const p = phaseFor(ev); if (p) setStreamingPhase(p); }`；`tool-running` 相位与 `setCurrentToolName` 在循环里的现调用点保留。
   - `executeTool` 改为委托：本地优先逻辑保留，WS 回退改 `conn.execTool(toolName, args)`。
7. **RPC 包装**：`requestFileList/requestFileContent/requestSyncPull/requestSyncFile` 变为 `conn.listFiles/readFile/syncPull/syncFile` 的直接透传（保留函数名）；`deleteProjectWorkspace` 用 `conn.sendRaw`。
8. **生命周期**：`loadSession`/`newSession`/项目切换 effect/unmount cleanup 沿用现逻辑，`wsRef.current?.close()` 等改为 `connRef.current?.disconnect()`（注意 `loadSession` 断开后 `setTimeout(() => connect(), 50)` 保留）。
9. **删除**：整个 `ws.onmessage` 大 switch、`toolResolvers`/`fileResolvers`、重连三件套（`shouldConnectRef`/`scheduleReconnect`/`clearReconnect`）、`sendInit`——全部已入 ServerConnection。
10. **行数目标**：< 450 行（原 1207）。

- [ ] **Step 1: 重写 useAgent.ts**（按上述 10 条要求执行；现文件的对应代码块是行为参照——搬迁为主，新写为辅）。

- [ ] **Step 2: 验证**

Run: `pnpm typecheck:app && pnpm --filter @pocket-code/app test && wc -l packages/app/src/hooks/useAgent.ts`
Expected: tsc 零错误；reducer 测试仍全 PASS；行数 < 450

- [ ] **Step 3: 消费面核查**（App.tsx 等零改动的前提验证）

Run: `grep -rn "data.toolName\|data.action\|\.promptTokens\|data.model\b" packages/app/src --include="*.ts*" | grep -v node_modules | grep -v aiClient; echo exit=$?`
Expected: 除 `aiClient.ts`（geek 内部，不属本期）外无命中（exit=1）

- [ ] **Step 4: 提交**

```bash
git add packages/app/src/hooks/useAgent.ts
git commit -m "refactor(app): useAgent 瘦身为组合层,云端/geek 共用 chatReducer(P6b 收官)"
```

---

### Task 7: 全仓收尾验证

**Files:** 无新改动（验证 + 可能的微调）

- [ ] **Step 1: 死代码断言**

Run: `grep -rn "StreamEvent" packages/*/src/ | grep -v node_modules; echo s=$?; ls packages/server/src/cli/bridge.ts 2>/dev/null; echo b=$?`
Expected: `s=1`（无命中）、`b=1`（文件不存在）

- [ ] **Step 2: 全仓验证**

Run: `pnpm build && pnpm test:all && pnpm typecheck:app`
Expected: 全绿（五包测试：wire/server/daemon/relay/app）

- [ ] **Step 3: 提交遗留（如有微调）并汇总**

```bash
git status --short   # 应为空;有遗留则审视后提交
```

---

## 验收对照（spec §5）

1. 全仓无 StreamEvent / bridge → Task 3 + Task 7 Step 1。
2. 出站 schema + satisfies → Task 1 + Task 3 Step 5。
3. useAgent <450 行、三层拆分、共用 reducer → Task 4/5/6。
4. App.tsx 零改动、typecheck 零错误 → Task 6 Step 2/3。
5. 构建与测试全绿 → Task 7。
6. 真机三模式回归（cloud 直连 / relay / geek+local：对话、思维链、工具调用、Diff/同步、中止、重连）→ 交付后用户执行。
