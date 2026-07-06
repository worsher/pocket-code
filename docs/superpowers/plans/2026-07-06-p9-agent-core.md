# P9 agent-core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新建同构 `@pocket-code/agent-core`（loop+工具注册表+ModelClient/RuntimeBackend 抽象），替换 server 的 AI-SDK 循环与 App 的 geek loop，工具声明/system prompt 全仓收敛为一份。

**Architecture:** 三阶段 11 任务。阶段一（T1-T5）：core 包——类型/safePath → 文件工具 → exec 类工具 → prompt+历史转换 → 主循环；阶段二（T6-T8）：NodeBackend → NodeModelClient(AI SDK 单步 spike) → agent.ts 切换；阶段三（T9-T11）：RnModelClient → App 切换(删 geekLoop) → 全仓验证。每阶段独立可验收。

**Tech Stack:** TypeScript（core 运行时零第三方依赖）、vitest、AI SDK ^4.3（仅 Node 适配层）、wire AgentEvent（仅 `import type`）。

## Global Constraints

- `@pocket-code/agent-core` 的 `package.json` **dependencies 为空**；对 wire 只 `import type`（devDependencies）；无任何 Node/RN 专有 import（`fs`/`child_process`/expo 一律禁止出现在 core 源码）。
- 事件契约 = wire `AgentEventType`（P6b），core 构造纯对象字面量。
- CLI 委托路径（claude/codex/gemini）零改动。
- `done` 事件由调用方发（core 循环不发 done）；`file-changed` 由 core 在 writeFile/editFile 工具成功后派生。
- server 行为对 App 不变；App UI（chatReducer 及其下游）零改动。
- 各包测试 `vitest run src`；提交信息中文前缀；分支 `feature/p9-cli-adapters`→ 更正：`feature/p9-agent-core`（已创建）。

## 背景事实（执行者必读）

- 仓库根 `/Users/wangfeiran/github/pocket-code`。参照源码（迁移的行为基准，实现时必读）：
  - `packages/server/src/tools.ts`（699 行）：`safePath`(:31)、`shellExec`(:53，docker/host 双分支，**host 模式非零退出抛异常**)、`gitEnv`(:90，HOME=workspace 隔离)、`resolveGitCwd`(:104，找 .git 所在目录)、16 个 `tool()`（readFile/writeFile/listFiles/runCommand/git×9/searchFiles/editFile）。
  - `packages/server/src/agent.ts`：非 CLI 循环(:180-260 附近)、`SYSTEM_PROMPT`、`AGENT_MAX_STEPS`（env，默认 25）、`mapAiSdkPart`。
  - `packages/app/src/services/aiClient.ts`（870 行）：`TOOL_DEFINITIONS`(:52，多 `runInBackground`/`stopProcess` 两个进程工具)、`buildSystemPrompt`(:302)、`streamChatOpenAI/Anthropic`（SSE，callbacks: onTextDelta/onThinking/onToolCall(id,name,args)/onDone/onError）、`streamChat`(:830 分发)。
  - `packages/app/src/hooks/geekLoop.ts`（101 行）：循环 + `buildChatHistory`（含 images 多模态 image_url parts）。
  - `packages/app/src/services/localFileSystem.ts`：`readLocalFile/writeLocalFile/listLocalFiles/executeLocalTool/getProjectWorkspaceRoot`。
- **spec 细化三处**（写计划时发现，随实现落地并同步 spec）：
  1. `CoreMessage` 的 user content 支持多模态：`string | ContentPart[]`（geek/server 都有 images 场景，纯 string 会丢图）。
  2. `RuntimeBackend.exec` 增加 `{ cwd?, env?, isolateHome? }`（git 工具需要 HOME 隔离与子目录 cwd；docker/host 的 HOME 差异由 backend 消化）；**exec 不抛非零**，统一返回 exitCode（host 模式的抛异常在 NodeBackend 内归一）。
  3. `RuntimeBackend` 增加**可选** `startProcess/stopProcess`（App 现有 runInBackground/stopProcess 工具，砍掉是净损）；注册表按 backend 能力裁剪。
- AI SDK ^4.3：`tool({ description, parameters })` **不带 execute** = client-side tool → `streamText` 浮出 `tool-call` part 后本步结束（无法自动继续），天然单步。喂回结果用 CoreMessage `{role:"tool", content:[{type:"tool-result", toolCallId, toolName, result}]}`。T7 首步用 mock 锁定该行为。
- app 的 vitest 只能跑纯 TS（无 RN import）——RnModelClient/适配器要保持纯净。
- 老会话历史：server DB 里存的是 AI-SDK 消息数组（`{role, content}`，content 可能是 parts 数组）。

## 文件结构

```
packages/agent-core/
  package.json / tsconfig.json          (T1)
  src/types.ts                          (T1) CoreMessage/ModelClient/ModelDelta/RuntimeBackend/ToolSchema
  src/safePath.ts + .test.ts            (T1) 迁自 tools.ts
  src/tools/registry.ts + .test.ts      (T2) buildToolRegistry
  src/tools/fileTools.ts + .test.ts     (T2) readFile/writeFile/editFile/listFiles/searchFiles
  src/tools/execTools.ts + .test.ts     (T3) runCommand/git×9/runInBackground/stopProcess/resolveGitCwd
  src/prompt.ts + .test.ts              (T4) SYSTEM_PROMPT 合并版
  src/history.ts + .test.ts             (T4) fromLegacyAiSdkMessages
  src/loop.ts + .test.ts                (T5) runAgentLoop
  src/index.ts                          (各任务追加导出)
packages/server/src/
  nodeBackend.ts + .test.ts             (T6)
  nodeModelClient.ts + .test.ts         (T7)
  agent.ts / tools.ts / aiSdkEvents.ts  (T8 改/缩/删)
packages/app/src/services/
  rnModelClient.ts + .test.ts           (T9)
  deviceBackend.ts                      (T10)
  aiClient.ts                           (T10 缩减为纯 SSE 客户端)
packages/app/src/hooks/
  useAgent.ts                           (T10 改)   geekLoop.ts (T10 删)
```

> 命令均在仓库根执行。core 新包完成 T1 后进根 `build`/`test:all`。

---

### Task 1: core 包骨架 + 核心类型 + safePath

**Files:**
- Create: `packages/agent-core/package.json`、`tsconfig.json`、`src/types.ts`、`src/safePath.ts`、`src/safePath.test.ts`、`src/index.ts`
- Modify: 根 `package.json`（build 已 `-r`；`test:all` 加 `--filter @pocket-code/agent-core`）

**Interfaces（Produces，后续所有任务的地基——签名必须逐字一致）:**

```ts
// types.ts 全量
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
```

- `safePath(workspace: string, relativePath: string): string`——迁自 tools.ts:31-37，**逐字**（含错误文案 "Path traversal not allowed"）。补 startsWith 边界：`full.startsWith(workspace + "/") || full === workspace`（修旧实现 `/ws` 匹配 `/ws-evil` 的前缀漏洞，属已知小加固，spec 精神内）。

- [ ] **Step 1: 建包**。`packages/agent-core/package.json`：

```json
{
  "name": "@pocket-code/agent-core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": { "build": "tsc", "test": "vitest run src" },
  "dependencies": {},
  "devDependencies": {
    "@pocket-code/wire": "workspace:*",
    "@types/node": "^22.0.0",
    "typescript": "^5.6.0",
    "vitest": "^4.0.18"
  }
}
```

`tsconfig.json` 抄 `packages/wire/tsconfig.json`（同为纯 TS 库），确认 `outDir: dist`、`declaration: true`。版本号以 wire 的 devDependencies 实际值为准对齐。

- [ ] **Step 2: 写失败测试** `src/safePath.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { safePath } from "./safePath.js";

describe("safePath", () => {
  it("resolves relative paths inside the workspace", () => {
    expect(safePath("/ws", "a/b.ts")).toBe("/ws/a/b.ts");
    expect(safePath("/ws", ".")).toBe("/ws");
  });
  it("rejects traversal outside the workspace", () => {
    expect(() => safePath("/ws", "../etc/passwd")).toThrow("Path traversal not allowed");
    expect(() => safePath("/ws", "a/../../x")).toThrow("Path traversal not allowed");
  });
  it("rejects sibling-prefix bypass (/ws-evil)", () => {
    expect(() => safePath("/ws", "../ws-evil/x")).toThrow("Path traversal not allowed");
  });
});
```

- [ ] **Step 3: 确认失败**

Run: `pnpm install && pnpm --filter @pocket-code/agent-core test`
Expected: FAIL（safePath 不存在）

- [ ] **Step 4: 实现** `src/safePath.ts`（注意 core 禁 Node import——`path.resolve` 是 Node！用纯字符串实现）：

```ts
// ── 工作区路径防穿越(同构:不依赖 node:path) ─────────────────
// 迁自 server tools.ts,并修 sibling 前缀绕过(/ws 匹配 /ws-evil)。

/** 极简 posix resolve:拼接后规范化 ".."/"."。仅处理 "/" 分隔(两端 workspace 均为 posix 风格)。 */
function resolvePosix(base: string, rel: string): string {
  const segs = (base + "/" + rel).split("/");
  const out: string[] = [];
  for (const s of segs) {
    if (!s || s === ".") continue;
    if (s === "..") out.pop();
    else out.push(s);
  }
  return "/" + out.join("/");
}

export function safePath(workspace: string, relativePath: string): string {
  const ws = resolvePosix(workspace, ".");
  const full = resolvePosix(ws, relativePath);
  if (full !== ws && !full.startsWith(ws + "/")) {
    throw new Error("Path traversal not allowed");
  }
  return full;
}
```

`src/index.ts`：`export * from "./types.js"; export { safePath } from "./safePath.js";`

`src/types.ts` 按 Interfaces 节全量落地。

根 `package.json` 的 `test:all` 在 wire 之后插入 `--filter @pocket-code/agent-core`。

- [ ] **Step 5: 确认通过 + 构建 + 全仓不回归**

Run: `pnpm --filter @pocket-code/agent-core test && pnpm --filter @pocket-code/agent-core build && pnpm build`
Expected: 全过；构建零错误

- [ ] **Step 6: 提交**

```bash
git add packages/agent-core package.json pnpm-lock.yaml
git commit -m "feat(agent-core): 包骨架+核心类型(CoreMessage/ModelClient/RuntimeBackend)+同构 safePath"
```

---

### Task 2: ToolRegistry + 文件类工具

**Files:**
- Create: `src/tools/registry.ts` + `registry.test.ts`、`src/tools/fileTools.ts` + `fileTools.test.ts`；Modify: `src/index.ts`

**Interfaces（Produces）:**

```ts
// registry.ts
export interface ToolDef {
  schema: ToolSchema;
  execute(backend: RuntimeBackend, args: Record<string, unknown>): Promise<unknown>;
}
export interface ToolRegistry {
  schemas: ToolSchema[];
  run(name: string, args: Record<string, unknown>): Promise<unknown>;  // 未知工具 → {success:false,error:"Unknown tool: <name>"}
  has(name: string): boolean;
}
export function buildToolRegistry(backend: RuntimeBackend): ToolRegistry;
// 组装 fileTools + execTools(T3 后);startProcess/stopProcess 仅当 backend 提供对应方法时注册
```

行为基准 = `packages/server/src/tools.ts` 对应工具（实现者必须对照源码迁移；错误路径统一 `{success:false, error}`，成功路径字段名与旧版一致——App 渲染依赖这些字段）：

| 工具 | 基准行为要点（对照 tools.ts） |
|---|---|
| readFile | safePath → backend.readFile → `{success:true, content}`；异常 → `{success:false,error:e.message}` |
| writeFile | safePath → 先 `backend.readFile(fullPath)` 捕获旧内容（抛错=文件不存在→oldContent=null）→ backend.writeFile → `{success:true, path, isNew, ...(isNew?{}:{oldContent}), newContent:content}`（**path/isNew 字段被 file-changed 派生依赖；oldContent/newContent 供 App DiffPreview 消费，对照 tools.ts:187-245**） |
| editFile | safePath → readFile → `oldText` 必须唯一出现一次（0 次/多次报错文案照旧版）→ 替换写回 → `{success:true, path, isNew:false, replaced:1, oldContent, newContent}`（oldContent=编辑前全文，newContent=替换后全文，对照 tools.ts:687-692） |
| listFiles | safePath → backend.listFiles → `{success:true, items:[{name,type}]}`；**工具层将 RuntimeBackend 的 `"dir"` 映射为 `"directory"`**（`RuntimeBackend.listFiles` 契约仍是 `"dir"\|"file"`，Task 1 已固化不改类型；App FileTreeView 判 `"directory"`，对照 tools.ts:265-280） |
| searchFiles | 经 `backend.exec` 跑 grep（旧版命令构造照迁：`grep -rn --include=... -e <pattern>`，2000 字符截断）→ `{success:true, matchCount, matches, truncated}`（matchCount=matches.length；truncated 对照 tools.ts:607-616 的 `matchCount`/`truncated` 字段，core 侧因按字符数截断改用 `stdout.length > 2000` 判定，语义等价） |

- [ ] **Step 1: 写失败测试**（fake backend 模式，后续任务复用）`src/tools/fileTools.test.ts`：

```ts
import { describe, it, expect, vi } from "vitest";
import { buildToolRegistry } from "./registry.js";
import type { RuntimeBackend } from "../types.js";

export function makeFakeBackend(over: Partial<RuntimeBackend> = {}): RuntimeBackend {
  const files = new Map<string, string>([["/ws/a.ts", "hello world"]]);
  return {
    readFile: vi.fn(async (p: string) => {
      const c = files.get(p);
      if (c === undefined) throw new Error("ENOENT: " + p);
      return c;
    }),
    writeFile: vi.fn(async (p: string, c: string) => {
      const isNew = !files.has(p);
      files.set(p, c);
      return { isNew };
    }),
    listFiles: vi.fn(async () => [
      { name: "a.ts", type: "file" as const },
      { name: ".git", type: "dir" as const },
    ]),
    exec: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    ...over,
  };
}

// 注:注册表工具接收 workspace 相对路径;fake backend 里用 /ws 前缀模拟 safePath 结果
describe("file tools", () => {
  const reg = () => buildToolRegistry(makeFakeBackend(), "/ws");

  it("readFile returns content; missing file yields success:false", async () => {
    expect(await reg().run("readFile", { path: "a.ts" })).toEqual({ success: true, content: "hello world" });
    const r: any = await reg().run("readFile", { path: "nope.ts" });
    expect(r.success).toBe(false);
    expect(r.error).toContain("ENOENT");
  });

  it("writeFile returns path+isNew (file-changed 派生依赖)", async () => {
    const r: any = await reg().run("writeFile", { path: "new.ts", content: "x" });
    expect(r).toEqual({ success: true, path: "new.ts", isNew: true });
  });

  it("editFile replaces unique oldText; ambiguous/missing oldText fails", async () => {
    const registry = reg();
    const ok: any = await registry.run("editFile", { path: "a.ts", oldText: "hello", newText: "hi" });
    expect(ok.success).toBe(true);
    const missing: any = await registry.run("editFile", { path: "a.ts", oldText: "zzz", newText: "y" });
    expect(missing.success).toBe(false);
  });

  it("listFiles returns items incl. dot entries", async () => {
    const r: any = await reg().run("listFiles", { path: "." });
    expect(r.items.some((i: any) => i.name === ".git")).toBe(true);
  });

  it("unknown tool yields structured error", async () => {
    expect(await reg().run("nope", {})).toEqual({ success: false, error: "Unknown tool: nope" });
  });

  it("path traversal is rejected via safePath", async () => {
    const r: any = await reg().run("readFile", { path: "../etc/passwd" });
    expect(r.success).toBe(false);
    expect(r.error).toContain("traversal");
  });
});
```

（`buildToolRegistry(backend, workspace)` 第二参 workspace——safePath 需要它；T5 的 loop、T8/T10 的接入方按此签名。）

- [ ] **Step 2: 确认失败** → **Step 3: 实现**（registry.ts + fileTools.ts；对照 tools.ts 逐工具迁移，schema 的 zod 定义改写为 JSON Schema 对象——`z.object({path: z.string()})` → `{type:"object",properties:{path:{type:"string"}},required:["path"]}`，description 逐字保留）→ **Step 4: 通过**

Run: `pnpm --filter @pocket-code/agent-core test`

- [ ] **Step 5: 提交**

```bash
git add packages/agent-core/src
git commit -m "feat(agent-core): ToolRegistry+文件类工具(迁自 server tools,行为对齐)"
```

---

### Task 3: exec 类工具（runCommand / git×9 / 进程可选二件）

**Files:**
- Create: `src/tools/execTools.ts` + `execTools.test.ts`；Modify: `src/tools/registry.ts`（组装）、`src/index.ts`

**Interfaces（Produces）:** 注册表新增工具：`runCommand`、`gitClone/gitStatus/gitAdd/gitCommit/gitPush/gitPull/gitLog/gitBranch/gitCheckout`、（backend 支持时）`runInBackground`、`stopProcess`。导出 `resolveGitCwd(backend, path?): Promise<string | undefined>`。

行为基准（对照 tools.ts 与 aiClient TOOL_DEFINITIONS）：

| 工具 | 要点 |
|---|---|
| runCommand | `backend.exec(command, {cwd, timeoutMs: 30000})`；exitCode===0 → `{success:true, stdout:切5000, stderr:切2000}`；非零 → `{success:false, error: stderr\|\|`exit ${exitCode}`, stdout, stderr}`（旧版 catch 语义等价） |
| git 全家 | 命令构造逐字迁移（如 gitStatus=`git status --porcelain -b`、gitLog=`git log --oneline -n <count>`……以 tools.ts 各 execute 为准）；统一 `env:{GIT_TERMINAL_PROMPT:"0",GIT_CONFIG_NOSYSTEM:"1"}, isolateHome:true`；cwd 用 `await resolveGitCwd(backend, args.path)`（gitClone 例外——它在 workspace 根跑） |
| resolveGitCwd | 同构重写：`listFiles(".")` 有 `.git` 目录 → undefined（根即仓库）；否则遍历一级子目录，恰一个含 `.git` → 返回该子目录名；零/多个 → undefined（行为对照 tools.ts:104-150 的语义） |
| runInBackground | backend.startProcess 存在才注册：`{success:true, processId}`；schema/description 迁自 aiClient TOOL_DEFINITIONS |
| stopProcess | 同上，`backend.stopProcess(processId)` → `{success:true}` |

- [ ] **Step 1: 写失败测试** `src/tools/execTools.test.ts`（fake backend 的 exec/startProcess mock 驱动；关键用例）：

```ts
import { describe, it, expect, vi } from "vitest";
import { buildToolRegistry } from "./registry.js";
import { resolveGitCwd } from "./execTools.js";
import { makeFakeBackend } from "./fileTools.test.js";

describe("runCommand", () => {
  it("success path slices stdout/stderr", async () => {
    const be = makeFakeBackend({ exec: vi.fn(async () => ({ stdout: "x".repeat(6000), stderr: "", exitCode: 0 })) });
    const r: any = await buildToolRegistry(be, "/ws").run("runCommand", { command: "ls" });
    expect(r.success).toBe(true);
    expect(r.stdout.length).toBe(5000);
  });
  it("non-zero exit yields success:false with stderr", async () => {
    const be = makeFakeBackend({ exec: vi.fn(async () => ({ stdout: "", stderr: "boom", exitCode: 2 })) });
    const r: any = await buildToolRegistry(be, "/ws").run("runCommand", { command: "bad" });
    expect(r).toMatchObject({ success: false, error: "boom" });
  });
});

describe("git tools", () => {
  it("gitStatus execs with HOME isolation and git env", async () => {
    const exec = vi.fn(async () => ({ stdout: "## main", stderr: "", exitCode: 0 }));
    const be = makeFakeBackend({ exec });
    await buildToolRegistry(be, "/ws").run("gitStatus", {});
    const [cmd, opts] = exec.mock.calls[0];
    expect(cmd).toContain("git status");
    expect(opts.isolateHome).toBe(true);
    expect(opts.env.GIT_TERMINAL_PROMPT).toBe("0");
  });
});

describe("resolveGitCwd", () => {
  it("returns undefined when workspace root has .git", async () => {
    const be = makeFakeBackend(); // listFiles 默认含 .git
    expect(await resolveGitCwd(be)).toBeUndefined();
  });
  it("finds the single subdirectory containing .git", async () => {
    const listFiles = vi.fn()
      .mockResolvedValueOnce([{ name: "repo", type: "dir" }, { name: "readme.md", type: "file" }])
      .mockResolvedValueOnce([{ name: ".git", type: "dir" }]);
    const be = makeFakeBackend({ listFiles });
    expect(await resolveGitCwd(be)).toBe("repo");
  });
  it("explicit path wins", async () => {
    expect(await resolveGitCwd(makeFakeBackend(), "sub")).toBe("sub");
  });
});

describe("process tools (capability-gated)", () => {
  it("registered only when backend provides startProcess/stopProcess", async () => {
    const noProc = buildToolRegistry(makeFakeBackend(), "/ws");
    expect(noProc.has("runInBackground")).toBe(false);
    const withProc = buildToolRegistry(
      makeFakeBackend({ startProcess: vi.fn(async () => ({ processId: "p1" })), stopProcess: vi.fn(async () => {}) }),
      "/ws"
    );
    expect(withProc.has("runInBackground")).toBe(true);
    const r: any = await withProc.run("runInBackground", { command: "npm run dev" });
    expect(r).toEqual({ success: true, processId: "p1" });
  });
});
```

- [ ] **Step 2: 确认失败** → **Step 3: 实现**（execTools.ts；git 命令构造**逐字对照 tools.ts 各工具 execute 体**，schema/description 照迁；registry.ts 组装 fileTools+execTools+能力门控进程工具）→ **Step 4: 通过**（`pnpm --filter @pocket-code/agent-core test`）

- [ ] **Step 5: 提交**

```bash
git add packages/agent-core/src
git commit -m "feat(agent-core): exec 类工具(runCommand/git 九件套/进程能力门控)+同构 resolveGitCwd"
```

---

### Task 4: system prompt 合并 + 老历史转换

**Files:**
- Create: `src/prompt.ts` + `prompt.test.ts`、`src/history.ts` + `history.test.ts`；Modify: `src/index.ts`

**Interfaces（Produces）:**
- `buildSystemPrompt(opts: { customPrompt?: string }): string`——以 server `agent.ts` 的 `SYSTEM_PROMPT` 为基（逐字迁移），diff 对照 app `aiClient.buildSystemPrompt` 把 app 独有且不冲突的句段合并（实现者逐段对照两版，合并结果在 PR 里可审）；customPrompt 拼接语义 = server 版（`\n\n## Project Instructions\n<cp>`）。
- `fromLegacyAiSdkMessages(raw: unknown[]): CoreMessage[]`——尽力转换：`{role:"user"|"assistant"|"system", content:string}` 直通；content 为 parts 数组 → 提取 text parts 拼接、image parts 转 ContentPart、tool-call/tool-result parts **丢弃并 console.warn 一次**；未知形状跳过。

- [ ] **Step 1: 写失败测试** `src/history.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { fromLegacyAiSdkMessages } from "./history.js";

describe("fromLegacyAiSdkMessages", () => {
  it("passes through plain role/content strings", () => {
    expect(fromLegacyAiSdkMessages([
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
    ])).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
    ]);
  });
  it("flattens text parts and keeps image parts; drops tool parts", () => {
    const out = fromLegacyAiSdkMessages([
      { role: "user", content: [{ type: "text", text: "look" }, { type: "image", image: "AAA", mimeType: "image/png" }] },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "t", toolName: "x", args: {} }] },
    ]);
    expect(out[0]).toEqual({ role: "user", content: [{ type: "text", text: "look" }, { type: "image", base64: "AAA", mimeType: "image/png" }] });
    expect(out[1]).toEqual({ role: "assistant", content: "" });
  });
  it("skips unknown shapes without throwing", () => {
    expect(fromLegacyAiSdkMessages([null, 42, { nope: true }])).toEqual([]);
  });
});
```

`src/prompt.test.ts`：`buildSystemPrompt({})` 非空且含关键句段（以迁移后的固定文案断言首行）；`buildSystemPrompt({customPrompt:"X"})` 以 `\n\n## Project Instructions\nX` 结尾。

- [ ] **Step 2: 确认失败** → **Step 3: 实现** → **Step 4: 通过** → **Step 5: 提交**

```bash
git add packages/agent-core/src
git commit -m "feat(agent-core): system prompt 合并版+AI-SDK 老历史尽力转换"
```

---

### Task 5: runAgentLoop 主循环

**Files:**
- Create: `src/loop.ts` + `loop.test.ts`；Modify: `src/index.ts`

**Interfaces（Produces，T8/T10 接入按此签名）:**

```ts
export interface RunAgentOptions {
  modelClient: ModelClient;
  backend: RuntimeBackend;
  workspace: string;                       // 供 registry 的 safePath
  system: string;
  history: CoreMessage[];                  // 不含本轮 user
  userMessage: string;
  images?: { base64: string; mimeType: string }[];
  onEvent: (ev: AgentEventType) => void;
  signal?: AbortSignal;
  maxSteps?: number;                       // 默认 25
}
export function runAgentLoop(opts: RunAgentOptions): Promise<{ messages: CoreMessage[]; fullText: string }>;
```

**循环语义（实现与测试的双重基准）：**
1. user 消息入 messages（有 images → ContentPart[]：text + images）。
2. 每步：`modelClient.streamStep({system, messages, tools: registry.schemas, signal})`；delta 处理：`text`→发 `text-delta` 并累积 fullText/stepText；`reasoning`→发 `reasoning-delta`；`tool-call`→收集；`usage`→累加。
3. 步末：assistant 消息（stepText+toolCalls）入 messages。无 tool calls → 结束。
4. 有 tool calls：逐个（顺序）发 `tool-call{callId,name,args}` → `registry.run` → 若 name∈{writeFile,editFile} 且 result.success 且 result.path → 追发 `file-changed{path, changeType: isNew?created:modified}` → 发 `tool-result{callId,result,isError: result?.success===false}` → `{role:"tool",toolCallId,toolName,content:JSON.stringify(result)}` 入 messages。
5. `signal.aborted` 在步间与工具间检查 → 提前结束（不发 error，交调用方）。
6. 达 maxSteps → 结束。
7. 结束前发一次汇总 `usage{inputTokens,outputTokens}`（累加值；两者均 0 则不发）。**不发 done**。
8. streamStep 抛异常 → 发 `error{message}` 后 rethrow（调用方决定 done/持久化）。

- [ ] **Step 1: 写失败测试** `src/loop.test.ts`（脚本化 fake ModelClient）：

```ts
import { describe, it, expect, vi } from "vitest";
import { runAgentLoop } from "./loop.js";
import { makeFakeBackend } from "./tools/fileTools.test.js";
import type { ModelClient, ModelDelta } from "./types.js";

/** 每次 streamStep 弹出下一段脚本 */
function scriptedClient(steps: ModelDelta[][]): ModelClient & { calls: any[] } {
  let i = 0;
  const calls: any[] = [];
  return {
    calls,
    async *streamStep(req) {
      calls.push(req);
      for (const d of steps[Math.min(i, steps.length - 1)]) yield d;
      i++;
    },
  };
}

const base = (client: ModelClient, over: any = {}) => ({
  modelClient: client,
  backend: makeFakeBackend(),
  workspace: "/ws",
  system: "sys",
  history: [],
  userMessage: "do it",
  onEvent: vi.fn(),
  ...over,
});

describe("runAgentLoop", () => {
  it("single step without tools: streams text, returns fullText, no done event", async () => {
    const client = scriptedClient([[{ type: "text", text: "he" }, { type: "text", text: "llo" }]]);
    const onEvent = vi.fn();
    const r = await runAgentLoop(base(client, { onEvent }));
    expect(r.fullText).toBe("hello");
    const types = onEvent.mock.calls.map((c) => c[0].type);
    expect(types).toEqual(["text-delta", "text-delta"]); // 无 usage(0)、无 done
    expect(r.messages.at(-1)).toEqual({ role: "assistant", content: "hello" });
  });

  it("tool round trip: executes via registry, emits call/result/file-changed, feeds next step", async () => {
    const client = scriptedClient([
      [{ type: "tool-call", id: "c1", name: "writeFile", args: { path: "n.ts", content: "x" } }],
      [{ type: "text", text: "done" }],
    ]);
    const onEvent = vi.fn();
    await runAgentLoop(base(client, { onEvent }));
    const evs = onEvent.mock.calls.map((c) => c[0]);
    expect(evs.map((e) => e.type)).toEqual(["tool-call", "file-changed", "tool-result", "text-delta"]);
    expect(evs[0]).toMatchObject({ callId: "c1", name: "writeFile" });
    expect(evs[1]).toMatchObject({ path: "n.ts", changeType: "created" });
    // 第二步收到 tool 消息
    expect(client.calls[1].messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "c1" });
  });

  it("failed tool marks isError and loop continues", async () => {
    const client = scriptedClient([
      [{ type: "tool-call", id: "c1", name: "readFile", args: { path: "nope.ts" } }],
      [{ type: "text", text: "recovered" }],
    ]);
    const onEvent = vi.fn();
    const r = await runAgentLoop(base(client, { onEvent }));
    const result = onEvent.mock.calls.map((c) => c[0]).find((e) => e.type === "tool-result");
    expect(result.isError).toBe(true);
    expect(r.fullText).toBe("recovered");
  });

  it("respects maxSteps", async () => {
    const client = scriptedClient([[{ type: "tool-call", id: "x", name: "listFiles", args: { path: "." } }]]);
    await runAgentLoop(base(client, { maxSteps: 3 }));
    expect(client.calls.length).toBe(3);
  });

  it("abort between steps stops the loop", async () => {
    const ac = new AbortController();
    const client = scriptedClient([[{ type: "tool-call", id: "x", name: "listFiles", args: { path: "." } }]]);
    const onEvent = vi.fn(() => ac.abort());
    const r = await runAgentLoop(base(client, { signal: ac.signal, onEvent }));
    expect(client.calls.length).toBe(1);
    expect(r).toBeDefined(); // 不抛
  });

  it("aggregated usage emitted once; images become content parts", async () => {
    const client = scriptedClient([
      [{ type: "usage", inputTokens: 10, outputTokens: 5 }, { type: "text", text: "a" }],
    ]);
    const onEvent = vi.fn();
    await runAgentLoop(base(client, { onEvent, images: [{ base64: "AAA", mimeType: "image/png" }] }));
    const usage = onEvent.mock.calls.map((c) => c[0]).filter((e) => e.type === "usage");
    expect(usage).toEqual([{ type: "usage", inputTokens: 10, outputTokens: 5 }]);
    const userMsg = client.calls[0].messages.find((m: any) => m.role === "user");
    expect(Array.isArray(userMsg.content)).toBe(true);
    expect(userMsg.content[1]).toMatchObject({ type: "image", base64: "AAA" });
  });

  it("model error: emits error event then rethrows", async () => {
    const client: ModelClient = { async *streamStep() { throw new Error("model down"); } };
    const onEvent = vi.fn();
    await expect(runAgentLoop(base(client, { onEvent }))).rejects.toThrow("model down");
    expect(onEvent.mock.calls.at(-1)![0]).toMatchObject({ type: "error", message: "model down" });
  });
});
```

- [ ] **Step 2: 确认失败** → **Step 3: 实现 loop.ts**（按循环语义 1-8 落地；内部 `buildToolRegistry(backend, workspace)`）→ **Step 4: 通过**（core 全测试）

- [ ] **Step 5: 提交**

```bash
git add packages/agent-core/src
git commit -m "feat(agent-core): runAgentLoop 主循环(多步/工具往返/事件流/abort/maxSteps)"
```

---

### Task 6: NodeBackend（server 侧）

**Files:**
- Create: `packages/server/src/nodeBackend.ts` + `nodeBackend.test.ts`；Modify: `packages/server/package.json`（dep `@pocket-code/agent-core: workspace:*`）

**Interfaces（Produces）:** `createNodeBackend(workspace: string, containerId?: string): RuntimeBackend`。行为基准 = tools.ts 的执行细节下沉：
- readFile/writeFile/listFiles：`node:fs/promises`（writeFile 先 stat 判 isNew、自动 mkdir 父目录——对照旧 writeFile 工具）；listFiles 用 `readdir(..., {withFileTypes:true})` 含 dot 项。
- exec：host 模式 `execAsync`（**catch 非零抛异常 → 归一 {stdout,stderr,exitCode}**，从 err.code/err.stdout/err.stderr 取值）；docker 模式经 `execInContainer`（返回值本就含 exitCode）；`isolateHome` → host: `env.HOME=workspace`，docker: `env.HOME="/workspace"`；maxBuffer 1MB、默认 timeout 30s 照旧。
- startProcess/stopProcess：**不实现**（server 侧现状无此工具，注册表自动不含——与现状一致）。

- [ ] **Step 1: 写失败测试**（真实临时目录，模式对照 shadowSnapshot.test）：

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeBackend } from "./nodeBackend.js";

let ws: string;
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), "pc-nb-")); });

describe("NodeBackend", () => {
  it("write/read/list round trip incl. dot entries and isNew", async () => {
    const be = createNodeBackend(ws);
    expect((await be.writeFile(join(ws, "a/b.ts"), "hi")).isNew).toBe(true);
    expect((await be.writeFile(join(ws, "a/b.ts"), "hi2")).isNew).toBe(false);
    expect(await be.readFile(join(ws, "a/b.ts"))).toBe("hi2");
    writeFileSync(join(ws, ".hidden"), "");
    const items = await be.listFiles(ws);
    expect(items.some((i) => i.name === ".hidden")).toBe(true);
    expect(items.find((i) => i.name === "a")?.type).toBe("dir");
  });

  it("exec returns exitCode without throwing on failure", async () => {
    const be = createNodeBackend(ws);
    const ok = await be.exec("echo hi");
    expect(ok).toMatchObject({ exitCode: 0 });
    expect(ok.stdout.trim()).toBe("hi");
    const bad = await be.exec("exit 3");
    expect(bad.exitCode).toBe(3);
  });

  it("isolateHome points HOME at the workspace", async () => {
    const be = createNodeBackend(ws);
    const r = await be.exec("echo $HOME", { isolateHome: true });
    expect(r.stdout.trim()).toBe(ws);
  });

  it("cwd option runs relative to workspace subdir", async () => {
    const be = createNodeBackend(ws);
    await be.exec("mkdir sub && echo x > sub/f.txt");
    const r = await be.exec("ls", { cwd: "sub" });
    expect(r.stdout).toContain("f.txt");
  });
});
```

- [ ] **Step 2: 确认失败** → **Step 3: 实现** → **Step 4: 通过**（`pnpm --filter @pocket-code/server test src/nodeBackend.test.ts`；需先 `pnpm --filter @pocket-code/agent-core build`）

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/nodeBackend.ts packages/server/src/nodeBackend.test.ts packages/server/package.json pnpm-lock.yaml
git commit -m "feat(server): NodeBackend(fs/exec/docker 归一,exec 不抛非零)"
```

---

### Task 7: NodeModelClient（AI SDK 单步适配）

**Files:**
- Create: `packages/server/src/nodeModelClient.ts` + `nodeModelClient.test.ts`

**Interfaces（Produces）:** `createNodeModelClient(modelKey: string): ModelClient`。内部复用现 `getModel(modelKey)`；`streamStep` 把 CoreMessage → AI SDK CoreMessage（tool 消息转 `{role:"tool",content:[{type:"tool-result",toolCallId,toolName,result}]}`、assistant.toolCalls 转 `{type:"tool-call",...}` parts、user ContentPart image 转 `{type:"image",image:base64}`），tools 声明转 `tool({description, parameters: jsonSchema(...)})` **不带 execute**，`streamText({..., maxSteps: 1})`，fullStream part → ModelDelta（text-delta/reasoning/tool-call/usage 映射同 aiSdkEvents 但目标为 ModelDelta）。

- [ ] **Step 1: spike 测试先行**（锁定"无 execute 工具单步浮出"的行为，mock streamText 注入）：`nodeModelClient.test.ts`——构造 `createNodeModelClient` 的可注入变体（第二参 `streamTextImpl` 默认真实实现），mock 返回 fullStream 含 text-delta/tool-call parts，断言：① ModelDelta 序列正确；② 传给 streamTextImpl 的 `tools` 每项无 `execute` 字段且 `maxSteps===1`；③ CoreMessage tool 往返消息转换后的形状（含 tool-result part）；④ usage promise → usage delta。

（测试代码由实现者按上述四断言写全——模式照 runner.test 的注入手法；本任务是全计划唯一"行为假设需 spike 验证"点，若真实 AI SDK 行为与假设不符——如无 execute 工具直接抛错——按 spec §8 预案改走 provider 原始接口并在报告中说明。）

- [ ] **Step 2: 确认失败** → **Step 3: 实现** → **Step 4: 通过** → **Step 5: 提交**

```bash
git add packages/server/src/nodeModelClient.ts packages/server/src/nodeModelClient.test.ts
git commit -m "feat(server): NodeModelClient(AI SDK 单步适配,无 execute 工具浮出 tool calls)"
```

---

### Task 8: server 切换到 core

**Files:**
- Modify: `packages/server/src/agent.ts`（非 CLI 分支 → core；SYSTEM_PROMPT/createTools 引用移除）、`packages/server/src/tools.ts`（缩减：保留 `getWorkspaceRoot` 与 docker 相关导出被别处引用的部分——先 grep 引用面再删）、`packages/server/src/messageHandler.ts`（tool-exec 用 core registry）
- Delete: `packages/server/src/aiSdkEvents.ts` + 测试（mapAiSdkPart 职责已入 NodeModelClient）

**要点（实现者逐条落实）:**
1. `runAgent` 非 CLI 分支：`fromLegacyAiSdkMessages(session.messages)` → `runAgentLoop({modelClient: createNodeModelClient(effectiveModelKey), backend: createNodeBackend(session.workspace, session.containerId), workspace: session.workspace, system: buildSystemPrompt({customPrompt: session.customPrompt}), history, userMessage, images, onEvent, signal, maxSteps: AGENT_MAX_STEPS})`；返回的 `messages` 覆盖 `session.messages`（此后持久化即 CoreMessage 格式）；catch 中 error/done 语义照旧（loop 已发 error，catch 只补 done——对照现 agent.ts:296-302 保持外部行为一致）；auto 路由/model-selected 事件/saveSession 不动。
2. `messageHandler` 的 `tool-exec` case：`createTools` 调用改 `buildToolRegistry(createNodeBackend(session.workspace, session.containerId), session.workspace).run(toolName, args)`。`list-files`/`read-file` case 同理改 registry。
3. `tools.ts`：grep 全仓引用（`getWorkspaceRoot` 被 messageHandler 用）→ 保留 `getWorkspaceRoot`，其余（tool()/createTools/shellExec/safePath/gitEnv/resolveGitCwd）删除；文件改名不必要，缩为 ~40 行。
4. 删除 `aiSdkEvents.ts`（+测试）；`agent.ts` 顶部 `SYSTEM_PROMPT` 常量删除（core 版接管）。
5. 验证：`pnpm --filter @pocket-code/server build && pnpm --filter @pocket-code/server test` 全过 + `grep -rn "createTools\|aiSdkEvents" packages/server/src` 零命中。

- [ ] **Step 1: 按要点 1-4 实施** → **Step 2: 验证（要点 5）** → **Step 3: 提交**

```bash
git add -A packages/server/src
git commit -m "refactor(server): 非 CLI 路径切换 agent-core(loop/工具/prompt 收敛),删 aiSdkEvents 与旧工具层"
```

---

### Task 9: RnModelClient（callbacks→AsyncIterable 适配）

**Files:**
- Create: `packages/app/src/services/rnModelClient.ts` + `rnModelClient.test.ts`
- Modify: `packages/app/package.json`（dep `@pocket-code/agent-core: workspace:*`——**运行时依赖**，core 零三方依赖故 Metro 可直编；tsconfig 无需动）

**Interfaces（Produces）:** `createRnModelClient(cfg: { modelConfig: ModelConfig; apiKey: string; settings: AppSettings; customPrompt?: string }): ModelClient`。
核心是**队列桥接器**（纯 TS 可单测）：

```ts
// 导出以便单测:
export function callbacksToAsyncIterable(
  start: (cb: {
    onDelta: (d: ModelDelta) => void;
    onDone: () => void;
    onError: (msg: string) => void;
  }) => void
): AsyncIterable<ModelDelta>;
```

实现：内部数组队列 + pending resolver；onDelta 入队/唤醒，onDone 终结，onError 以 rejected promise 终结（迭代方 throw）。`streamStep`：CoreMessage → aiClient `ChatMessage[]`（assistant.toolCalls → `tool_calls` OpenAI 形状、tool 消息 → `{role:"tool",content,tool_call_id}`、user ContentPart → image_url data URI——对照被删的 geekLoop.buildChatHistory 逐语义等价）；tools schema → aiClient 需要吗？——aiClient 的 streamChatOpenAI 目前内部用全局 TOOL_DEFINITIONS：**T10 将其改为参数传入**（本任务先在 rnModelClient 里定义转换，T10 接线）。调 `streamChat({model, apiKey, messages, callbacks: 适配, signal, settings, customPrompt})`，onToolCall(id,name,args)→`{type:"tool-call",...}`、onThinking→reasoning、onTextDelta→text。

- [ ] **Step 1: 写失败测试**（只测 `callbacksToAsyncIterable` 与消息转换纯函数——`toChatMessages(coreMessages): ChatMessage[]` 同文件导出）：

```ts
import { describe, it, expect } from "vitest";
import { callbacksToAsyncIterable, toChatMessages } from "./rnModelClient";

describe("callbacksToAsyncIterable", () => {
  it("yields deltas in order and completes on onDone", async () => {
    const it_ = callbacksToAsyncIterable(({ onDelta, onDone }) => {
      onDelta({ type: "text", text: "a" });
      setTimeout(() => { onDelta({ type: "text", text: "b" }); onDone(); }, 5);
    });
    const got: any[] = [];
    for await (const d of it_) got.push(d);
    expect(got.map((d) => d.text)).toEqual(["a", "b"]);
  });
  it("onError rejects the iteration", async () => {
    const it_ = callbacksToAsyncIterable(({ onError }) => setTimeout(() => onError("boom"), 1));
    await expect((async () => { for await (const _ of it_) {/**/} })()).rejects.toThrow("boom");
  });
});

describe("toChatMessages", () => {
  it("converts tool round trips to OpenAI shapes", () => {
    const out = toChatMessages([
      { role: "user", content: "hi" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "readFile", args: { path: "a" } }] },
      { role: "tool", toolCallId: "c1", toolName: "readFile", content: "{\"ok\":true}" },
    ]);
    expect(out[1]).toMatchObject({ role: "assistant", tool_calls: [{ id: "c1", function: { name: "readFile" } }] });
    expect(out[2]).toMatchObject({ role: "tool", tool_call_id: "c1" });
  });
  it("converts image parts to data-URI image_url", () => {
    const out = toChatMessages([{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", base64: "AAA", mimeType: "image/png" }] }]);
    expect((out[0] as any).content[1].image_url.url).toBe("data:image/png;base64,AAA");
  });
});
```

- [ ] **Step 2: 确认失败** → **Step 3: 实现** → **Step 4: 通过**（`pnpm --filter @pocket-code/app test` + `pnpm typecheck:app`）→ **Step 5: 提交**

```bash
git add packages/app/src/services/rnModelClient.ts packages/app/src/services/rnModelClient.test.ts packages/app/package.json pnpm-lock.yaml
git commit -m "feat(app): RnModelClient(aiClient callbacks→AsyncIterable 桥接+消息转换)"
```

---

### Task 10: App 切换到 core（DeviceBackend + useAgent + 删 geekLoop + aiClient 缩减）

**Files:**
- Create: `packages/app/src/services/deviceBackend.ts`
- Modify: `packages/app/src/hooks/useAgent.ts`、`packages/app/src/services/aiClient.ts`
- Delete: `packages/app/src/hooks/geekLoop.ts`

**要点：**
1. `createDeviceBackend(opts: { projectId?: string; execTool: (name, args) => Promise<unknown> }): RuntimeBackend`：readFile/writeFile/listFiles → `localFileSystem` 的 readLocalFile/writeLocalFile/listLocalFiles（路径基 `getProjectWorkspaceRoot(projectId) ?? getDefaultWorkspace()`；返回值形状适配 RuntimeBackend——对照 localFileSystem 实际签名）；exec → `execTool("runCommand", {command,...})` 解析其 `{success,stdout,stderr,error}` 回 ExecResult（success:false 且无 exitCode → exitCode 1）；startProcess/stopProcess → `execTool("runInBackground"/"stopProcess", ...)`（保持 geek 现有能力）。
2. `useAgent.sendGeekMessage`：`runGeekLoop` 调用替换为：

```ts
const { messages: nextHistory } = await runAgentLoop({
  modelClient: createRnModelClient({ modelConfig, apiKey, settings, customPrompt: customPromptRef.current }),
  backend: createDeviceBackend({ projectId: projectIdRef.current, execTool: executeTool }),
  workspace: "/",              // DeviceBackend 内部已定根,safePath 以 "/" 为界
  system: buildSystemPrompt({ customPrompt: customPromptRef.current }),
  history: coreHistoryRef.current,     // 新增 ref:geek 会话的 CoreMessage 史(与 UI messages 并行维护)
  userMessage: content,
  images: images?.map((i) => ({ base64: i.base64, mimeType: i.mimeType })),
  onEvent: emitGeek,
  signal: abortController.signal,
  maxSteps: 10,               // 保持 geek 现值
});
coreHistoryRef.current = nextHistory;
```

（`emitGeek` 已消费 AgentEvent——zero UI 改动；旧 `buildChatHistory` 从 UI messages 重建历史的方式被 coreHistoryRef 取代——新会话/loadSession/newSession/项目切换时重置该 ref，与 setMessages([]) 同点。）
3. 删 `geekLoop.ts`；`useAgent` 移除其 import；`Message` re-export 不受影响。
4. `aiClient.ts` 缩减：删 `TOOL_DEFINITIONS`、`buildSystemPrompt`（system prompt 改由调用方传入——`streamChat` 增加必传 `systemPrompt` 参数并删 settings/customPrompt 参数，内部两处 `buildSystemPrompt(...)` 调用改用传入值）、删任何 chatHistory 构建残留；`streamChatOpenAI/Anthropic` 的 tools 声明来源改为参数 `tools: ToolDefinition[]`（rnModelClient 从 core `ToolSchema` 转换传入——转换器在 rnModelClient 内，形状对照 aiClient 现 ToolDefinition）。
5. 验证：`pnpm typecheck:app` 零错误；`pnpm --filter @pocket-code/app test` 全过；`grep -rn "geekLoop\|TOOL_DEFINITIONS" packages/app/src` 零命中；`wc -l packages/app/src/services/aiClient.ts` 显著小于 870。

- [ ] **Step 1: 按要点实施** → **Step 2: 验证（要点 5）** → **Step 3: 提交**

```bash
git add -A packages/app/src
git commit -m "refactor(app): geek 模式切换 agent-core(DeviceBackend+RnModelClient),删 geekLoop,aiClient 缩为纯 SSE 客户端"
```

---

### Task 11: 全仓验证 + 文档收尾

- [ ] **Step 1: 死代码断言**

Run: `grep -rn "geekLoop\|createTools\|aiSdkEvents\|TOOL_DEFINITIONS" packages/*/src | grep -v node_modules; echo g=$?`
Expected: g=1

- [ ] **Step 2: 全仓验证**

Run: `pnpm build && pnpm test:all && pnpm typecheck:app`
Expected: 六包（+agent-core）全绿

- [ ] **Step 3: 文档**。`plan.md`：P9 移入已完成表（`| P9 | agent-core 同构包+双侧接入,三套 loop 收编完成 | specs+plans/2026-07-06-p9 |`），待办重排（P10 升首位）。spec 的 §3 接口按实现落地版同步三处细化（ContentPart/exec opts/进程可选方法——已在本计划"背景事实"列明）。

- [ ] **Step 4: 提交**

```bash
git add plan.md "docs/superpowers/specs/2026-07-06-p9-agent-core与拆分评估-design.md"
git commit -m "docs: P9 完成态同步(plan.md 路线图+spec 接口细化落地版)"
```

---

## 验收对照（spec §7）

1. 构建/测试/typecheck 全绿 + geekLoop 不存在 + 工具声明/prompt 各一份 → T10 要点5、T11。
2. server 行为不变 → T8（现有测试）+ 用户真机回归。
3. geek 经 core 跑通 + 工具全集 → T10 + 用户真机（重点：geek 下 git/search 新可用）。
4. core 运行时零三方依赖 → T1 package.json + T11 复查。
