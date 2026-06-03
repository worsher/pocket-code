# P4-part2 sync 协议 + 服务端 sync handler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 P4 的影子快照核心接成可被客户端调用的**同步协议发送端**：定义 `sync-pull`/`sync-file` 协议消息，服务端据此为会话工作区产出"同步清单(增量增删改 + 快照 commit)"与"按快照读取文件内容(base64)"，并加固 `createSnapshot` 使其在无 git 配置的工作区也能工作。

**Architecture:** ① 加固 `shadowSnapshot.createSnapshot`：commit-tree 注入 `GIT_*_NAME/EMAIL` 身份 env(否则未配 user.name/email 的工作区会报 "Committer identity unknown")。② wire 新增入站消息 `SyncPullMessage{sinceCommit?}`、`SyncFileMessage{commit,path}`。③ 新增 `packages/server/src/sync/syncHandler.ts`：`ensureGitRepo`(无 .git 则 git init)、`handleSyncPull`(快照→增量清单,sinceCommit 不可达时回退全量)、`handleSyncFile`(读文件→base64)，三者均接收 workspace 路径+send 回调，**可脱离 DB/auth 直接单测**。④ messageHandler 加 `sync-pull`/`sync-file` 两个 case 路由到 syncHandler。**本计划不含手机侧 isomorphic-git restore 与 UI**(后续 part3)。

**Tech Stack:** TypeScript、Node child_process(git)、Zod(@pocket-code/wire)、vitest(临时真实 git 仓库)。

---

## 背景事实（执行者必读）

- P4-part1 已落地 `packages/server/src/sync/shadowSnapshot.ts`：`createSnapshot`(零污染→`refs/pocket-code/worktree`)、`changedFiles(repoDir, fromCommit|null, toCommit)`、`readSnapshotFile(repoDir, commit, relPath)→Buffer`、`clearSnapshots`。其 commit-tree 当前**未注入身份**,依赖仓库已配 user.name/email——真实工作区可能没配,故本计划 Task 1 加固。
- `messageHandler` 的 `switch(msg.type)` 中,每个需要工作区的 case 都以 `if (!session) { send({type:"error",error:"No session. Send init first."}); return; }` 开头,然后用 `session.workspace` 调用逻辑并 `send(...)` 响应(参见 list-files/read-file case)。
- 入站消息经 `WsMessage`(@pocket-code/wire) 校验;新增入站消息须加进 wire 的 `WsMessage` discriminatedUnion,server 才会接受。出站响应(sync-manifest/sync-file-content)沿用现有"ad-hoc send"模式,本计划不为其加 wire schema(与现状一致,出站 schema 统一留待 P3c)。
- wire/messages.ts 有 `optStr(maxLen)` 助手(string|undefined|null→undefined)。
- `git commit-tree` 的 `GIT_COMMITTER_NAME/EMAIL`、`GIT_AUTHOR_NAME/EMAIL` 环境变量优先于 user.* 配置,故注入 env 在任何仓库都生效。
- server 测试经 `vitest run src` 递归扫描;syncHandler/shadowSnapshot 测试用临时真实 git 仓库(CI ubuntu 有 git)。

## 文件结构（本计划涉及）

- 修改：`packages/server/src/sync/shadowSnapshot.ts`（createSnapshot 注入身份 env）+ `shadowSnapshot.test.ts`（加无配置仓库用例）
- 修改：`packages/wire/src/messages.ts`（加 sync 入站消息 + union）、`packages/wire/src/index.ts`（导出）、`packages/wire/src/messages.test.ts`（用例）
- 新建：`packages/server/src/sync/syncHandler.ts` + `syncHandler.test.ts`
- 修改：`packages/server/src/messageHandler.ts`（加 sync-pull / sync-file 两个 case + import）

> 所有命令均在仓库根目录 `/Users/worsher/code/self/pocket-code` 执行。

---

### Task 1: 加固 createSnapshot 注入 git 身份

**Files:**
- Modify: `packages/server/src/sync/shadowSnapshot.ts`
- Modify: `packages/server/src/sync/shadowSnapshot.test.ts`

- [ ] **Step 1: 加失败测试（无 user 配置的仓库也能快照）**

在 `packages/server/src/sync/shadowSnapshot.test.ts` 的 `describe("shadowSnapshot", ...)` 块内末尾(最后一个 `it(...)` 之后、describe 闭合 `});` 之前)插入：

```typescript
  it("works on a repo with NO user.name/email configured (injects identity)", async () => {
    // 新建一个完全未配置身份的仓库
    const bare = mkdtempSync(join(tmpdir(), "pc-noid-"));
    try {
      git(bare, "init", "-q", "-b", "main");
      writeFileSync(join(bare, "f.txt"), "hi\n");
      // 注意:不设置 user.email / user.name
      const snap = await createSnapshot(bare);
      expect(snap.commit).toMatch(/^[0-9a-f]{40}$/);
      const tree = git(bare, "ls-tree", "-r", "--name-only", snap.commit);
      expect(tree).toBe("f.txt");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: 跑测试确认新用例失败**

Run: `pnpm --filter @pocket-code/server test`
Expected: FAIL —— 新用例报错（commit-tree 因 "Committer identity unknown" 失败）。

- [ ] **Step 3: 在 createSnapshot 注入身份 env**

在 `packages/server/src/sync/shadowSnapshot.ts` 中，把 `const SNAP_REF = "refs/pocket-code/worktree";` 下一行后追加一个常量（紧跟在 `const MAX_BUFFER = ...;` 之后）：

```typescript
// commit-tree 需要提交者身份;注入固定身份,使其在未配 user.name/email 的工作区也能工作。
const IDENTITY_ENV: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: "Pocket Code",
  GIT_AUTHOR_EMAIL: "pocket@local",
  GIT_COMMITTER_NAME: "Pocket Code",
  GIT_COMMITTER_EMAIL: "pocket@local",
};
```

然后把 createSnapshot 里的这一行：

```typescript
    const commit = (await git(repoDir, commitArgs)).trim();
```

替换为：

```typescript
    const commit = (await git(repoDir, commitArgs, IDENTITY_ENV)).trim();
```

- [ ] **Step 4: 跑测试确认全绿 + 提交**

Run: `pnpm --filter @pocket-code/server test`
Expected: PASS —— shadowSnapshot.test.ts 全过(原 5 + 新 1 = 6)。

```bash
git add packages/server/src/sync/shadowSnapshot.ts packages/server/src/sync/shadowSnapshot.test.ts
git commit -m "fix(server): 影子快照 createSnapshot 注入 git 身份(支持无配置工作区)"
```

---

### Task 2: wire 新增 sync 入站消息

**Files:**
- Modify: `packages/wire/src/messages.ts`
- Modify: `packages/wire/src/index.ts`
- Modify: `packages/wire/src/messages.test.ts`

- [ ] **Step 1: 在 messages.ts 定义 sync 消息并加入 union**

在 `packages/wire/src/messages.ts` 中，把 `AbortMessage` 定义之后、`/** Discriminated union of all valid business messages */` 之前，插入：

```typescript
export const SyncPullMessage = z.object({
  type: z.literal("sync-pull"),
  sinceCommit: optStr(64),
});

export const SyncFileMessage = z.object({
  type: z.literal("sync-file"),
  commit: z.string().min(1).max(64),
  path: z.string().min(1).max(2048),
});
```

然后把 `WsMessage` 的 discriminatedUnion 数组里 `AbortMessage,` 一行替换为：

```typescript
  AbortMessage,
  SyncPullMessage,
  SyncFileMessage,
```

- [ ] **Step 2: 在 index.ts 导出**

在 `packages/wire/src/index.ts` 的业务消息导出块里，把 `AbortMessage,` 一行替换为：

```typescript
  AbortMessage,
  SyncPullMessage,
  SyncFileMessage,
```

- [ ] **Step 3: 加 schema 测试**

在 `packages/wire/src/messages.test.ts` 的 `describe("wire — WsMessage validation", ...)` 块内末尾(describe 闭合前)插入：

```typescript
  it("should accept valid sync-pull (with and without sinceCommit)", () => {
    expect(WsMessage.safeParse({ type: "sync-pull" }).success).toBe(true);
    expect(WsMessage.safeParse({ type: "sync-pull", sinceCommit: "abc123" }).success).toBe(true);
  });

  it("should accept valid sync-file", () => {
    const r = WsMessage.safeParse({ type: "sync-file", commit: "deadbeef", path: "src/a.ts" });
    expect(r.success).toBe(true);
  });

  it("should reject sync-file without commit/path", () => {
    expect(WsMessage.safeParse({ type: "sync-file", path: "a" }).success).toBe(false);
    expect(WsMessage.safeParse({ type: "sync-file", commit: "x" }).success).toBe(false);
  });
```

- [ ] **Step 4: 构建 wire 并测试 + 提交**

Run: `pnpm --filter @pocket-code/wire build && pnpm --filter @pocket-code/wire test`
Expected: 构建成功；测试 PASS（messages.test.ts 原 14 + 新 3 = 17，加 agentEvent 12，共 29 passed）。

```bash
git add packages/wire/src/messages.ts packages/wire/src/index.ts packages/wire/src/messages.test.ts
git commit -m "feat(wire): 新增 sync-pull / sync-file 入站消息"
```

---

### Task 3: 服务端 syncHandler（TDD）

**Files:**
- Create: `packages/server/src/sync/syncHandler.test.ts`（先写）
- Create: `packages/server/src/sync/syncHandler.ts`（实现）

- [ ] **Step 1: 先写失败测试**

创建 `packages/server/src/sync/syncHandler.test.ts`，内容：

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureGitRepo, handleSyncPull, handleSyncFile } from "./syncHandler.js";

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf-8" }).trim();
}

let ws: string;
let sent: any[];
const send = (m: unknown) => sent.push(m);

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "pc-sync-"));
  sent = [];
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

describe("syncHandler", () => {
  it("ensureGitRepo initializes a repo when none exists", async () => {
    expect(existsSync(join(ws, ".git"))).toBe(false);
    await ensureGitRepo(ws);
    expect(existsSync(join(ws, ".git"))).toBe(true);
    // idempotent
    await ensureGitRepo(ws);
    expect(existsSync(join(ws, ".git"))).toBe(true);
  });

  it("handleSyncPull on a fresh (non-git) workspace returns a full manifest", async () => {
    writeFileSync(join(ws, "a.txt"), "v1\n");
    writeFileSync(join(ws, "b.txt"), "v2\n");
    await handleSyncPull(ws, null, send);
    expect(sent).toHaveLength(1);
    const m = sent[0];
    expect(m.type).toBe("sync-manifest");
    expect(m.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(m.parent).toBeNull();
    const byPath = Object.fromEntries(m.files.map((f: any) => [f.path, f.status]));
    expect(byPath["a.txt"]).toBe("A");
    expect(byPath["b.txt"]).toBe("A");
  });

  it("handleSyncPull returns incremental changes since a prior commit", async () => {
    writeFileSync(join(ws, "a.txt"), "v1\n");
    await handleSyncPull(ws, null, send);
    const first = sent[0].commit;

    writeFileSync(join(ws, "a.txt"), "v2\n");
    writeFileSync(join(ws, "c.txt"), "new\n");
    sent = [];
    await handleSyncPull(ws, first, send);
    const m = sent[0];
    expect(m.parent).toBe(first);
    const byPath = Object.fromEntries(m.files.map((f: any) => [f.path, f.status]));
    expect(byPath["a.txt"]).toBe("M");
    expect(byPath["c.txt"]).toBe("A");
  });

  it("handleSyncPull falls back to full manifest when sinceCommit is unreachable", async () => {
    writeFileSync(join(ws, "a.txt"), "v1\n");
    await handleSyncPull(ws, "0000000000000000000000000000000000000000", send);
    const m = sent[0];
    expect(m.type).toBe("sync-manifest");
    // 回退为全量:a.txt 记为 A
    expect(m.files.some((f: any) => f.path === "a.txt" && f.status === "A")).toBe(true);
  });

  it("handleSyncFile returns base64 content that round-trips", async () => {
    writeFileSync(join(ws, "a.txt"), "hello sync\n");
    await handleSyncPull(ws, null, send);
    const commit = sent[0].commit;
    sent = [];
    await handleSyncFile(ws, commit, "a.txt", send);
    const m = sent[0];
    expect(m.type).toBe("sync-file-content");
    expect(m.path).toBe("a.txt");
    expect(m.encoding).toBe("base64");
    expect(Buffer.from(m.content, "base64").toString("utf-8")).toBe("hello sync\n");
  });

  it("handleSyncFile reports an error for a missing path", async () => {
    writeFileSync(join(ws, "a.txt"), "x\n");
    await handleSyncPull(ws, null, send);
    const commit = sent[0].commit;
    sent = [];
    await handleSyncFile(ws, commit, "does-not-exist.txt", send);
    const m = sent[0];
    expect(m.type).toBe("sync-file-content");
    expect(m.error).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @pocket-code/server test`
Expected: FAIL —— 无法解析 `./syncHandler.js`。

- [ ] **Step 3: 实现 syncHandler**

创建 `packages/server/src/sync/syncHandler.ts`，内容：

```typescript
// ── sync 服务端 handler(发送端/开发机侧) ───────────────────
// 把影子快照接成同步协议:sync-pull → 快照+增量清单;sync-file → 文件内容。
// 接收 workspace 路径 + send 回调,与 messageHandler/DB/auth 解耦,便于单测。

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  createSnapshot,
  changedFiles,
  readSnapshotFile,
  type ChangedFile,
} from "./shadowSnapshot.js";

const exec = promisify(execFile);

/** 工作区不是 git 仓库时,初始化一个(同步需要 git 做快照)。 */
export async function ensureGitRepo(workspace: string): Promise<void> {
  if (!existsSync(join(workspace, ".git"))) {
    await exec("git", ["init", "-q"], { cwd: workspace });
  }
}

/**
 * 处理 sync-pull:对工作区做影子快照,返回相对 sinceCommit 的增量清单。
 * sinceCommit 不可达(如手机记录的旧 commit 已被清理)时回退为全量。
 */
export async function handleSyncPull(
  workspace: string,
  sinceCommit: string | null,
  send: (msg: unknown) => void
): Promise<void> {
  await ensureGitRepo(workspace);
  const snap = await createSnapshot(workspace);
  let files: ChangedFile[];
  try {
    files = await changedFiles(workspace, sinceCommit, snap.commit);
  } catch {
    // sinceCommit 不可达 → 回退全量
    files = await changedFiles(workspace, null, snap.commit);
  }
  send({ type: "sync-manifest", commit: snap.commit, parent: snap.parent, files });
}

/** 处理 sync-file:返回某快照里某文件的 base64 内容(失败则带 error)。 */
export async function handleSyncFile(
  workspace: string,
  commit: string,
  path: string,
  send: (msg: unknown) => void
): Promise<void> {
  try {
    const content = await readSnapshotFile(workspace, commit, path);
    send({
      type: "sync-file-content",
      path,
      encoding: "base64",
      content: content.toString("base64"),
    });
  } catch (err: any) {
    send({ type: "sync-file-content", path, error: err?.message ?? "read failed" });
  }
}
```

- [ ] **Step 4: 跑测试确认全绿 + 提交**

Run: `pnpm --filter @pocket-code/server test`
Expected: PASS —— syncHandler.test.ts 6 个用例全过。

```bash
git add packages/server/src/sync/syncHandler.ts packages/server/src/sync/syncHandler.test.ts
git commit -m "feat(server): sync handler(sync-pull 增量清单 + sync-file 文件内容)"
```

---

### Task 4: messageHandler 接入 sync 分支

**Files:**
- Modify: `packages/server/src/messageHandler.ts`

- [ ] **Step 1: 导入 sync handler**

在 `packages/server/src/messageHandler.ts` 顶部 import 区，把 `import { WsMessage } from "@pocket-code/wire";` 这一行之后追加：

```typescript
import { handleSyncPull, handleSyncFile } from "./sync/syncHandler.js";
```

- [ ] **Step 2: 在 switch 中加 sync-pull / sync-file 两个 case**

在 `messageHandler.ts` 的 `switch (msg.type)` 中，找到 `case "read-file": { ... }` 这个 case 的结束 `}`（即 `// ── Session management ──` 注释之前），在其后、`// ── Session management ──` 之前插入：

```typescript
          // ── Code sync (shadow snapshot) ──
          case "sync-pull": {
            if (!session) {
              send({ type: "error", error: "No session. Send init first." });
              return;
            }
            try {
              await handleSyncPull(session.workspace, msg.sinceCommit ?? null, send);
            } catch (err: any) {
              send({ type: "error", error: `sync-pull failed: ${err.message}` });
            }
            break;
          }

          case "sync-file": {
            if (!session) {
              send({ type: "error", error: "No session. Send init first." });
              return;
            }
            try {
              await handleSyncFile(session.workspace, msg.commit, msg.path, send);
            } catch (err: any) {
              send({ type: "error", error: `sync-file failed: ${err.message}` });
            }
            break;
          }

```

- [ ] **Step 3: 全链路验证 + 提交**

Run: `pnpm build && pnpm test:all && pnpm typecheck:app && echo ALL GREEN`
Expected: 末尾 `ALL GREEN`（wire 29 / server 含 sync 测试 / daemon 7 / relay 5 全过；server build 通过，说明 messageHandler 正确引用 syncHandler 与新消息字段 msg.sinceCommit/msg.commit/msg.path）。

```bash
git add packages/server/src/messageHandler.ts
git commit -m "feat(server): messageHandler 接入 sync-pull / sync-file 路由"
```

---

## Self-Review

**1. Spec coverage（对照 spec 第 4 节"代码存储与同步"）：**
- ✅ 同步协议(发送端)：`sync-pull`(快照+增量清单)、`sync-file`(取文件) → Task 2/3/4
- ✅ 工作区自动 git 化 → `ensureGitRepo`
- ✅ 增量 + 不可达回退全量 → `handleSyncPull`
- ✅ 无 git 配置工作区可用 → Task 1 身份注入
- 注：手机侧 isomorphic-git restore(把清单+文件写入本地 clone) + 活动文件快路径 + FilesTab 集成 = part3(需仿真器验证)。中继模式下经 relay 透传 sync 消息已天然支持(relay 转发任意 payload)。

**2. Placeholder scan：** 无 TBD/TODO；每步含完整代码与精确命令、预期输出。

**3. Type consistency：** `handleSyncPull/handleSyncFile` 形参与 messageHandler 调用一致(workspace:string, sinceCommit:string|null / commit:string, path:string, send)；`ChangedFile` 复用 shadowSnapshot 导出类型；wire `SyncPullMessage.sinceCommit`(optStr→string|undefined,messageHandler 用 `?? null` 归一)、`SyncFileMessage.commit/path`(必填 string) 与 handler 调用匹配；出站 `sync-manifest`/`sync-file-content` 为 ad-hoc(不在 WsMessage union,符合现状)。

**4. 风险：** ① 大文件 base64 单帧返回(readSnapshotFile maxBuffer 256MB),超大仓库后续可改分块/流式——MVP 够用。② `changedFiles` 的不可达 sinceCommit 回退依赖 `git diff` 抛错被 catch;已用 Task3 用例(全 0 commit)覆盖。③ 出站 sync 响应未 schema 化,与现有出站消息一致,统一留待 P3c。
