# P10 client-core + Web 端 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 抽 `@pocket-code/client-core`（serverConnection/chatReducer/relayClient 正典迁移+去 RN 化），新建 `packages/web`（Vite+React）实现 Chat+Files+Diff，验证包边界。

**Architecture:** 方案 A（正典迁移+冻结副本）：三模块源码移入 client-core，App 副本冻结不切换（P11 删除）。Web 端用框架无关的 `WebAgentStore`（可纯 vitest 测试）+ `useSyncExternalStore` 薄绑定消费 client-core。

**Tech Stack:** TypeScript strict / tsc 构建 / vitest；Web: Vite ^7 + React 19 + 手写 CSS（无 UI 库）。

**Spec:** `docs/superpowers/specs/2026-07-10-p10-client-core-web-design.md`

## Global Constraints

- client-core 依赖仅 `@pocket-code/wire` 与 `@pocket-code/agent-core`（全 type-only → 运行时零依赖）；不依赖 app/server/relay/daemon。
- client-core 包模板照抄 agent-core：`"type": "module"`、tsc 构建、`vitest run src`、TS strict。
- App 侧三个源文件+两个测试文件本期冻结：只修 bug 且必须双侧同步；唯一允许的改动是类型来源反转（2 处 re-export）。
- 每个 task 结束跑该包测试；Task 4、10 额外跑全仓门禁 `pnpm build && pnpm test:all && pnpm typecheck:app`。
- 提交信息遵循仓库惯例：`feat(client-core): ...`/`feat(web): ...` 中文摘要。

---

### Task 1: client-core 包骨架 + types.ts + chatReducer 迁入

**Files:**
- Create: `packages/client-core/package.json`
- Create: `packages/client-core/tsconfig.json`
- Create: `packages/client-core/src/types.ts`
- Create: `packages/client-core/src/chatReducer.ts`（复制自 `packages/app/src/hooks/chatReducer.ts`，改 2 个 import）
- Create: `packages/client-core/src/chatReducer.test.ts`（复制自 `packages/app/src/hooks/chatReducer.test.ts`，改 import）
- Create: `packages/client-core/src/index.ts`
- Modify: 根 `package.json` scripts.test:all（追加 client-core filter）

**Interfaces:**
- Produces: `types.ts` 导出 `StreamingPhase`、`StoredImageAttachment`、`StoredMessage`；`chatReducer.ts` 导出 `Message`、`ToolCall`、`ImageAttachment`、`applyAgentEvent`、`phaseFor`、`truncateCoreHistory`、`storedToCoreMessages`（签名与 App 现有完全一致）。

- [ ] **Step 1: 建包骨架**

`packages/client-core/package.json`：

```json
{
  "name": "@pocket-code/client-core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": { "build": "tsc", "test": "vitest run src" },
  "dependencies": {
    "@pocket-code/wire": "workspace:*",
    "@pocket-code/agent-core": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0",
    "vitest": "^4.0.18"
  }
}
```

`packages/client-core/tsconfig.json`：照抄 `packages/agent-core/tsconfig.json`（target ES2022 / module ESNext / moduleResolution bundler / declaration / outDir dist / rootDir src / strict）。**追加一行 `"lib": ["ES2022", "DOM"]`**（serverConnection/relayClient 用到 `WebSocket`/`MessageEvent` 全局类型）。

- [ ] **Step 2: 写 types.ts**

`packages/client-core/src/types.ts`（从 App 两处定义原样收编）：

```ts
// ── 会话与 UI 状态类型(从 App 收编,client-core 为正典) ──────────

/** 流式指示器阶段(原 app/components/StreamingIndicator) */
export type StreamingPhase =
  | "connecting"
  | "thinking"
  | "generating"
  | "tool-calling"
  | "tool-running"
  | "idle";

/** 存档消息(原 app/store/chatHistory) */
export interface StoredImageAttachment {
  uri: string;
  base64: string;
  mimeType: "image/jpeg" | "image/png";
}

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  toolCalls?: {
    toolName: string;
    args: Record<string, unknown>;
    result?: unknown;
  }[];
  images?: StoredImageAttachment[];
  timestamp: number;
  pending?: boolean;
  modelUsed?: string;
}
```

- [ ] **Step 3: 迁入 chatReducer 与测试**

复制 `packages/app/src/hooks/chatReducer.ts` → `packages/client-core/src/chatReducer.ts`，只改头部两个 import：

```ts
// 原:
// import type { StreamingPhase } from "../components/StreamingIndicator";
// import type { StoredMessage } from "../store/chatHistory";
// 改为:
import type { StreamingPhase, StoredMessage } from "./types";
```

（`import type { AgentEventType } from "@pocket-code/wire"` 与 `import type { CoreMessage } from "@pocket-code/agent-core"` 不变。）

复制 `packages/app/src/hooks/chatReducer.test.ts` → `packages/client-core/src/chatReducer.test.ts`，将 `from "./chatReducer"` 保持不变（同目录）；若测试内有 `../store/chatHistory` 或组件导入则同样改为 `./types`。

`packages/client-core/src/index.ts`（本 task 先导出已迁部分）：

```ts
export type { StreamingPhase, StoredImageAttachment, StoredMessage } from "./types";
export type { Message, ToolCall, ImageAttachment } from "./chatReducer";
export { applyAgentEvent, phaseFor, truncateCoreHistory, storedToCoreMessages } from "./chatReducer";
```

- [ ] **Step 4: 接线并跑测试**

根 `package.json` 的 `test:all` 在 `--filter @pocket-code/agent-core` 后追加 `--filter @pocket-code/client-core`。

```bash
pnpm install
pnpm --filter @pocket-code/client-core test
pnpm --filter @pocket-code/client-core build
```

Expected: chatReducer 18 个测试 PASS；tsc 无错误。

- [ ] **Step 5: Commit**

```bash
git add packages/client-core 根package.json pnpm-lock.yaml
git commit -m "feat(client-core): 包骨架+types 收编+chatReducer 正典迁入(测试随迁 18 例)"
```

---

### Task 2: relayClient 迁入 + onTokenPersist 去 RN 化（TDD）

**Files:**
- Create: `packages/client-core/src/relayClient.ts`（复制自 `packages/app/src/services/relayClient.ts`，去 RN 化）
- Create: `packages/client-core/src/relayClient.test.ts`（复制自 App 同名测试 + 新增 1 例）
- Modify: `packages/client-core/src/index.ts`

**Interfaces:**
- Produces: `RelayClient` 类（API 与 App 版一致）；`RelayClientOptions` 新增 `onTokenPersist?: (token: string, machineId: string) => void`，**删除**对 `updateSettings` 的内部调用。

- [ ] **Step 1: 先写失败测试**

复制 `packages/app/src/services/relayClient.test.ts` → `packages/client-core/src/relayClient.test.ts`（import 路径 `./relayClient` 不变），在 describe 末尾新增：

```ts
it("invokes onTokenPersist instead of touching any store on updateToken", () => {
  const persisted: Array<[string, string]> = [];
  const client = new RelayClient({
    relayUrl: "wss://aigc.zj.cn/relay",
    machineId: "",
    deviceId: "d_1",
    deviceName: "Pocket Code Web",
    onTokenPersist: (token, machineId) => persisted.push([token, machineId]),
  });
  client.updateToken("tok_1", "m_1");
  expect(persisted).toEqual([["tok_1", "m_1"]]);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @pocket-code/client-core test
```

Expected: FAIL —— `Cannot find module './relayClient'`（源文件尚未迁入）。

- [ ] **Step 3: 迁入源文件并去 RN 化**

复制 `packages/app/src/services/relayClient.ts` → `packages/client-core/src/relayClient.ts`，三处改动：

1. 删除 `import { updateSettings } from "../store/settings";`
2. `RelayClientOptions` 增加字段：

```ts
export interface RelayClientOptions {
  relayUrl: string;
  machineId: string;
  deviceId: string;
  deviceName: string;
  /** Long-lived device JWT */
  token?: string;
  /** 配对成功后由宿主持久化 token(RN: updateSettings 包装;Web: localStorage) */
  onTokenPersist?: (token: string, machineId: string) => void;
}
```

3. `updateToken` 替换实现：

```ts
/** Update current connection token (called after successful pair) */
public updateToken(token: string, machineId: string) {
  this.opts.token = token;
  this.opts.machineId = machineId;
  this.opts.onTokenPersist?.(token, machineId);
}
```

`index.ts` 追加：

```ts
export { RelayClient } from "./relayClient";
export type { RelayClientOptions, RelayEvent } from "./relayClient";
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @pocket-code/client-core test && pnpm --filter @pocket-code/client-core build
```

Expected: relayClient 6 例（5 迁入 + 1 新增）PASS；tsc 无错误（包内已无 `../store/settings` 引用）。

- [ ] **Step 5: Commit**

```bash
git add packages/client-core/src
git commit -m "feat(client-core): relayClient 迁入+onTokenPersist 注入回调去 RN 化(TDD 新增 1 例)"
```

---

### Task 3: serverConnection 迁入 + 新增核心路径测试

**Files:**
- Create: `packages/client-core/src/serverConnection.ts`（复制自 `packages/app/src/services/serverConnection.ts`，import 改同目录）
- Create: `packages/client-core/src/serverConnection.test.ts`（全新）
- Modify: `packages/client-core/src/index.ts`

**Interfaces:**
- Produces: `ServerConnection` 类、`ConnectionConfig`、`ConnectionHandlers`（与 App 版签名一致）。关键成员：`connect()`、`disconnect()`、`sendRaw(obj): boolean`、`isOpen`、`listFiles(path?): Promise<any>`、`readFile(path): Promise<any>`、`execTool`、`syncPull`、`syncFile`。

- [ ] **Step 1: 先写失败测试**

`packages/client-core/src/serverConnection.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServerConnection, type ConnectionConfig, type ConnectionHandlers } from "./serverConnection";

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CLOSED;
  sent: string[] = [];
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    // 真实 WebSocket 语义:close 后 readyState 变 CLOSED(否则 isOpen 仍 true,connect() 早退,重连测试失真)
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
  /** 测试辅助:模拟服务端握手完成 */
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  receive(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

function makeConfig(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    getServerUrl: () => "ws://localhost:8787",
    isRelayMode: () => false,
    getRelayOptions: () => ({ machineId: "", deviceId: "d_1" }),
    getAuthToken: () => undefined,
    getDeviceId: () => "d_1",
    buildInitPayload: () => ({ sessionId: undefined }),
    isRelayPaired: () => false,
    ...overrides,
  };
}

function makeHandlers(overrides: Partial<ConnectionHandlers> = {}): ConnectionHandlers {
  return {
    onAgentEvent: () => {},
    onAuth: () => {},
    onSession: () => {},
    onConnected: () => {},
    onDisconnected: () => {},
    onAuthError: () => {},
    onFileChanged: () => {},
    ...overrides,
  };
}

describe("ServerConnection", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("registers with deviceId on open when no auth token (LAN mode)", () => {
    const conn = new ServerConnection(makeConfig(), makeHandlers());
    conn.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    expect(JSON.parse(ws.sent[0])).toEqual({ type: "register", deviceId: "d_1" });
    conn.disconnect();
  });

  it("sends init with token+payload after auth message and forwards onAuth", () => {
    const auths: Array<[string, string]> = [];
    const conn = new ServerConnection(
      makeConfig(),
      makeHandlers({ onAuth: (t, u) => auths.push([t, u]) })
    );
    conn.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.receive({ type: "auth", token: "tok_1", userId: "u_1" });
    expect(auths).toEqual([["tok_1", "u_1"]]);
    const init = JSON.parse(ws.sent[1]);
    expect(init.type).toBe("init");
    expect(init.token).toBe("tok_1");
    conn.disconnect();
  });

  it("resolves listFiles via _reqId and rejects on timeout", async () => {
    vi.useFakeTimers();
    const conn = new ServerConnection(makeConfig(), makeHandlers());
    conn.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();

    const p1 = conn.listFiles("src");
    const sent = JSON.parse(ws.sent.at(-1)!);
    expect(sent.type).toBe("list-files");
    ws.receive({ type: "file-list", path: "src", _reqId: sent._reqId, success: true, items: [] });
    await expect(p1).resolves.toMatchObject({ success: true, items: [] });

    const p2 = conn.listFiles("src");
    const rejected = expect(p2).rejects.toThrow("File list timed out");
    vi.advanceTimersByTime(10_001);
    await rejected;
    conn.disconnect();
  });

  it("routes normalized agent events to onAgentEvent", () => {
    const events: string[] = [];
    const conn = new ServerConnection(
      makeConfig(),
      makeHandlers({ onAgentEvent: (ev) => events.push(ev.type) })
    );
    conn.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.receive({ type: "text-delta", text: "hi" });
    ws.receive({ type: "done" });
    expect(events).toEqual(["text-delta", "done"]);
    conn.disconnect();
  });

  it("stops reconnecting and calls onAuthError on Unauthorized error", () => {
    vi.useFakeTimers();
    let authError = "";
    const conn = new ServerConnection(
      makeConfig(),
      makeHandlers({ onAuthError: (m) => (authError = m) })
    );
    conn.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.receive({ type: "error", error: "Unauthorized device" });
    expect(authError).toContain("重新配对");
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1); // 未重连
  });

  it("reconnects with exponential backoff after unexpected close", () => {
    vi.useFakeTimers();
    const conn = new ServerConnection(makeConfig(), makeHandlers());
    conn.connect();
    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].close(); // 意外断开(close 置 CLOSED 再触发 onclose)
    vi.advanceTimersByTime(2_000); // 第 1 次退避 2s
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances[1].close();
    vi.advanceTimersByTime(3_999);
    expect(FakeWebSocket.instances).toHaveLength(2); // 第 2 次退避 4s,未到
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(3);
    conn.disconnect();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @pocket-code/client-core test
```

Expected: FAIL —— `Cannot find module './serverConnection'`。

- [ ] **Step 3: 迁入源文件**

复制 `packages/app/src/services/serverConnection.ts` → `packages/client-core/src/serverConnection.ts`，只改一个 import：`import { RelayClient } from "./relayClient";`（原本就是相对同目录，检查无 App 内部引用残留即可——该文件其余 import 仅 `@pocket-code/wire` 类型）。

`index.ts` 追加：

```ts
export { ServerConnection } from "./serverConnection";
export type { ConnectionConfig, ConnectionHandlers } from "./serverConnection";
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @pocket-code/client-core test && pnpm --filter @pocket-code/client-core build
```

Expected: 全部 PASS（chatReducer 18 + relayClient 6 + serverConnection 6 = 30 例）；tsc 无错误。

- [ ] **Step 5: Commit**

```bash
git add packages/client-core/src
git commit -m "feat(client-core): serverConnection 迁入+核心路径测试 6 例(握手/RPC 超时/事件路由/授权失效/重连退避)"
```

---

### Task 4: App 侧类型来源反转 + 冻结头注释

**Files:**
- Modify: `packages/app/package.json`（devDependencies 加 `"@pocket-code/client-core": "workspace:*"`）
- Modify: `packages/app/src/components/StreamingIndicator/index.tsx:4-10`（StreamingPhase 定义 → re-export）
- Modify: `packages/app/src/store/chatHistory.ts:5-25`（StoredMessage/StoredImageAttachment 定义 → re-export）
- Modify: `packages/app/src/services/serverConnection.ts:1`、`packages/app/src/services/relayClient.ts:1`、`packages/app/src/hooks/chatReducer.ts:1`（加冻结头注释）
- Modify: `packages/app/src/services/relayClient.test.ts:1`、`packages/app/src/hooks/chatReducer.test.ts:1`（加冻结头注释）

**Interfaces:**
- Consumes: Task 1 的 `types.ts` 导出。
- Produces: App 内 `StreamingPhase`/`StoredMessage`/`StoredImageAttachment` 的唯一定义在 client-core（App 原位置变 re-export，所有既有 import 路径不变仍可用）。

- [ ] **Step 1: app 依赖接线**

`packages/app/package.json` devDependencies 加 `"@pocket-code/client-core": "workspace:*"`（type-only 消费，编译期擦除，不进 Metro bundle），然后 `pnpm install`。

- [ ] **Step 2: 类型来源反转**

`StreamingIndicator/index.tsx`：删除 `export type StreamingPhase = ...` 的 7 行定义，替换为：

```ts
export type { StreamingPhase } from "@pocket-code/client-core";
```

（同文件内部使用处 `phase: StreamingPhase` 需要值内导入：在文件顶部加 `import type { StreamingPhase } from "@pocket-code/client-core";`。）

`store/chatHistory.ts`：删除 `StoredImageAttachment`/`StoredMessage` 两个 interface 定义（约 5-25 行），替换为：

```ts
import type { StoredMessage } from "@pocket-code/client-core";
export type { StoredMessage, StoredImageAttachment } from "@pocket-code/client-core";
```

（文件内其余函数签名用到 `StoredMessage` 处由上面的 import type 满足。）

- [ ] **Step 3: 冻结头注释**

五个文件首行上方各加：

```ts
// 【冻结副本】已被 @pocket-code/client-core 收编为正典(P10)。此副本冻结:
// 只修 bug 且必须双侧同步;P11 RN 切换消费 client-core 时删除本文件。
```

- [ ] **Step 4: 全仓门禁**

```bash
pnpm build && pnpm test:all && pnpm typecheck:app
```

Expected: 全绿（app 71 例不回归；typecheck 无错误——重点确认 re-export 后 chatReducer/组件的既有 import 全部可解析）。

- [ ] **Step 5: Commit**

```bash
git add packages/app pnpm-lock.yaml
git commit -m "refactor(app): StreamingPhase/StoredMessage 类型来源反转到 client-core+三模块副本冻结头注释"
```

---

### Task 5: web 包脚手架 + webStorage 设置模块（TDD）

**Files:**
- Create: `packages/web/package.json`、`packages/web/tsconfig.json`、`packages/web/vite.config.ts`、`packages/web/index.html`
- Create: `packages/web/src/main.tsx`、`packages/web/src/App.tsx`、`packages/web/src/styles.css`
- Create: `packages/web/src/webStorage.ts`、`packages/web/src/webStorage.test.ts`
- Modify: 根 `package.json`（scripts 加 `"dev:web": "pnpm --filter @pocket-code/web dev"`；test:all 追加 `--filter @pocket-code/web`）

**Interfaces:**
- Produces: `WebSettings` 类型与 `createSettingsStore(storage: Pick<Storage, "getItem" | "setItem">)`，返回 `{ load(): WebSettings; save(patch: Partial<WebSettings>): WebSettings }`。后续 task 用它读写连接配置。

- [ ] **Step 1: 包骨架**

`packages/web/package.json`：

```json
{
  "name": "@pocket-code/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "test": "vitest run src"
  },
  "dependencies": {
    "@pocket-code/client-core": "workspace:*",
    "@pocket-code/wire": "workspace:*",
    "react": "19.1.0",
    "react-dom": "19.1.0"
  },
  "devDependencies": {
    "@types/react": "~19.1.0",
    "@types/react-dom": "~19.1.0",
    "@vitejs/plugin-react": "^5.0.0",
    "typescript": "~5.9.2",
    "vite": "^7.0.0",
    "vitest": "^4.0.18"
  }
}
```

`packages/web/tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src"]
}
```

`packages/web/vite.config.ts`：

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
});
```

`packages/web/index.html`：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Pocket Code Web</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`packages/web/src/main.tsx`：

```tsx
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

`packages/web/src/App.tsx`（占位壳，Task 7-9 填充）：

```tsx
export default function App() {
  return <div className="app">Pocket Code Web</div>;
}
```

`packages/web/src/styles.css`（基础深色主题，后续 task 增量补）：

```css
:root {
  --bg: #111418;
  --bg-panel: #1a1f26;
  --fg: #e6e6e6;
  --fg-dim: #8a919c;
  --accent: #4f9cf9;
  --green: #3fb950;
  --red: #f85149;
  --border: #2b3138;
  --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 -apple-system, sans-serif; }
.app { display: flex; flex-direction: column; height: 100vh; }
```

- [ ] **Step 2: 先写 webStorage 失败测试**

`packages/web/src/webStorage.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { createSettingsStore, type WebSettings } from "./webStorage";

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

describe("createSettingsStore", () => {
  it("returns defaults (lan mode, generated deviceId) on empty storage", () => {
    const store = createSettingsStore(fakeStorage());
    const s = store.load();
    expect(s.mode).toBe("lan");
    expect(s.deviceId).toMatch(/^web_/);
  });

  it("persists patches and keeps deviceId stable across loads", () => {
    const storage = fakeStorage();
    const s1 = createSettingsStore(storage).load();
    createSettingsStore(storage).save({ mode: "relay", relayUrl: "wss://aigc.zj.cn/relay" });
    const s2 = createSettingsStore(storage).load();
    expect(s2.mode).toBe("relay");
    expect(s2.relayUrl).toBe("wss://aigc.zj.cn/relay");
    expect(s2.deviceId).toBe(s1.deviceId);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

```bash
pnpm install && pnpm --filter @pocket-code/web test
```

Expected: FAIL —— `Cannot find module './webStorage'`。

- [ ] **Step 4: 实现 webStorage**

`packages/web/src/webStorage.ts`：

```ts
// ── Web 端设置持久化(localStorage 注入,可测) ─────────────────

export interface WebSettings {
  mode: "lan" | "relay";
  /** LAN 直连:ws://开发机IP:端口 */
  serverUrl: string;
  /** relay 模式:relay 地址(https/wss 均可,client-core 会归一化) */
  relayUrl: string;
  /** relay 配对产物 */
  relayMachineId: string;
  relayToken?: string;
  deviceId: string;
}

const KEY = "pocket-code-web-settings";

const DEFAULTS: Omit<WebSettings, "deviceId"> = {
  mode: "lan",
  serverUrl: "ws://localhost:8787",
  relayUrl: "",
  relayMachineId: "",
};

export function createSettingsStore(storage: Pick<Storage, "getItem" | "setItem">) {
  function load(): WebSettings {
    let parsed: Partial<WebSettings> = {};
    try {
      parsed = JSON.parse(storage.getItem(KEY) || "{}");
    } catch {
      /* 损坏的存档按空处理 */
    }
    const deviceId = parsed.deviceId || `web_${Math.random().toString(36).slice(2, 10)}`;
    const settings = { ...DEFAULTS, ...parsed, deviceId };
    if (!parsed.deviceId) storage.setItem(KEY, JSON.stringify(settings));
    return settings;
  }

  function save(patch: Partial<WebSettings>): WebSettings {
    const next = { ...load(), ...patch };
    storage.setItem(KEY, JSON.stringify(next));
    return next;
  }

  return { load, save };
}
```

- [ ] **Step 5: 跑测试确认通过 + 构建冒烟**

```bash
pnpm --filter @pocket-code/web test && pnpm --filter @pocket-code/web build
```

Expected: 2 例 PASS；vite build 产出 `dist/`。

- [ ] **Step 6: Commit**

```bash
git add packages/web 根package.json pnpm-lock.yaml
git commit -m "feat(web): Vite+React 脚手架+webStorage 设置模块(localStorage 注入,TDD 2 例)"
```

---

### Task 6: WebAgentStore（框架无关编排）+ 冒烟测试

**Files:**
- Create: `packages/web/src/webAgentStore.ts`
- Create: `packages/web/src/webAgentStore.test.ts`
- Create: `packages/web/src/useWebAgent.ts`（useSyncExternalStore 薄绑定）

**Interfaces:**
- Consumes: client-core 的 `ServerConnection`/`ConnectionConfig`/`ConnectionHandlers`/`applyAgentEvent`/`phaseFor`/`Message`/`StreamingPhase`；Task 5 的 `WebSettings`。
- Produces:

```ts
interface AgentState {
  messages: Message[];
  phase: StreamingPhase;
  connected: boolean;
  authError: string | null;
  sessionId: string | null;
}
class WebAgentStore {
  constructor(settings: WebSettings);
  getState(): AgentState;
  subscribe(listener: () => void): () => void;
  connect(): void;
  disconnect(): void;
  sendMessage(content: string): void; // 追加 user+pending assistant 消息并 sendRaw {type:"message"}
  readonly conn: ServerConnection;    // Files 页直接用 listFiles/readFile
}
```

- [ ] **Step 1: 先写失败测试**

`packages/web/src/webAgentStore.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebAgentStore } from "./webAgentStore";
import type { WebSettings } from "./webStorage";

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CLOSED;
  sent: string[] = [];
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {}
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  receive(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

const SETTINGS: WebSettings = {
  mode: "lan",
  serverUrl: "ws://localhost:8787",
  relayUrl: "",
  relayMachineId: "",
  deviceId: "web_test",
};

describe("WebAgentStore", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("streams a full turn: send → text-delta → tool-call/result → done", () => {
    const store = new WebAgentStore(SETTINGS);
    const seen: string[] = [];
    store.subscribe(() => seen.push(store.getState().phase));
    store.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    expect(store.getState().connected).toBe(true);

    store.sendMessage("改一下 README");
    const outbound = JSON.parse(ws.sent.at(-1)!);
    expect(outbound).toMatchObject({ type: "message", content: "改一下 README" });
    expect(store.getState().messages).toHaveLength(2); // user + pending assistant

    ws.receive({ type: "text-delta", text: "好的" });
    ws.receive({ type: "tool-call", callId: "c1", name: "writeFile", args: { path: "README.md" } });
    ws.receive({ type: "tool-result", callId: "c1", result: { success: true, newContent: "x" } });
    ws.receive({ type: "done" });

    const state = store.getState();
    const assistant = state.messages.at(-1)!;
    expect(assistant.content).toBe("好的");
    expect(assistant.toolCalls).toHaveLength(1);
    expect(assistant.toolCalls![0].result).toMatchObject({ success: true });
    expect(state.phase).toBe("idle");
    expect(seen).toContain("generating");
  });

  it("captures sessionId and surfaces auth errors", () => {
    const store = new WebAgentStore(SETTINGS);
    store.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.receive({ type: "session", sessionId: "s_1" });
    expect(store.getState().sessionId).toBe("s_1");
    ws.receive({ type: "error", error: "Unauthorized device" });
    expect(store.getState().authError).toContain("重新配对");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @pocket-code/web test
```

Expected: FAIL —— `Cannot find module './webAgentStore'`。

- [ ] **Step 3: 实现 WebAgentStore**

`packages/web/src/webAgentStore.ts`：

```ts
// ── Web 端 agent 编排(框架无关,对应 App useAgent 的最小子集) ──
// 砍掉 RN 专属:AppState/通知/离线队列/geek 模式/会话存档。

import {
  ServerConnection,
  applyAgentEvent,
  phaseFor,
  type ConnectionConfig,
  type ConnectionHandlers,
  type Message,
  type StreamingPhase,
} from "@pocket-code/client-core";
import type { WebSettings } from "./webStorage";

export interface AgentState {
  messages: Message[];
  phase: StreamingPhase;
  connected: boolean;
  authError: string | null;
  sessionId: string | null;
}

export class WebAgentStore {
  private state: AgentState = {
    messages: [],
    phase: "idle",
    connected: false,
    authError: null,
    sessionId: null,
  };
  private listeners = new Set<() => void>();
  readonly conn: ServerConnection;

  constructor(private settings: WebSettings) {
    const config: ConnectionConfig = {
      getServerUrl: () => (settings.mode === "relay" ? settings.relayUrl : settings.serverUrl),
      isRelayMode: () => settings.mode === "relay",
      getRelayOptions: () => ({
        machineId: settings.relayMachineId,
        deviceId: settings.deviceId,
        token: settings.relayToken,
      }),
      getAuthToken: () => undefined, // LAN 模式走 register 流程
      getDeviceId: () => settings.deviceId,
      buildInitPayload: () => ({ sessionId: this.state.sessionId ?? undefined }),
      isRelayPaired: () => !!(settings.relayToken && settings.relayMachineId),
    };
    const handlers: ConnectionHandlers = {
      onAgentEvent: (ev) => {
        const messages = applyAgentEvent(this.state.messages, ev);
        const phase = phaseFor(ev) ?? this.state.phase;
        this.setState({ messages, phase });
      },
      onAuth: () => {}, // LAN 匿名注册返回的 token 由 ServerConnection 自己回发 init
      onSession: (sessionId) => this.setState({ sessionId }),
      onConnected: () => this.setState({ connected: true, authError: null }),
      onDisconnected: () => this.setState({ connected: false }),
      onAuthError: (message) => this.setState({ authError: message }),
      onFileChanged: () => {}, // Files 页手动刷新,MVP 不做推送联动
    };
    this.conn = new ServerConnection(config, handlers);
  }

  getState(): AgentState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  connect(): void {
    this.conn.connect();
  }

  disconnect(): void {
    this.conn.disconnect();
  }

  sendMessage(content: string): void {
    const now = Date.now();
    const user: Message = { id: `u_${now}`, role: "user", content, timestamp: now };
    const pending: Message = { id: `a_${now}`, role: "assistant", content: "", timestamp: now, pending: true };
    this.setState({
      messages: [...this.state.messages, user, pending],
      phase: "connecting",
    });
    this.conn.sendRaw({ type: "message", content });
  }

  private setState(patch: Partial<AgentState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }
}
```

`packages/web/src/useWebAgent.ts`：

```ts
import { useSyncExternalStore } from "react";
import type { WebAgentStore, AgentState } from "./webAgentStore";

export function useWebAgent(store: WebAgentStore): AgentState {
  return useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.getState()
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @pocket-code/web test && pnpm --filter @pocket-code/web build
```

Expected: 4 例 PASS（webStorage 2 + webAgentStore 2）；build 通过。

- [ ] **Step 5: Commit**

```bash
git add packages/web/src
git commit -m "feat(web): WebAgentStore 框架无关编排+useSyncExternalStore 绑定(冒烟 2 例)"
```

---

### Task 7: 连接/配对页

**Files:**
- Create: `packages/web/src/pages/ConnectPage.tsx`
- Modify: `packages/web/src/App.tsx`（顶层状态机:未连接→ConnectPage;已连接→主界面壳+tab 导航）
- Modify: `packages/web/src/styles.css`（表单/按钮/状态条样式增量）

**Interfaces:**
- Consumes: `createSettingsStore`（Task 5）、`RelayClient`（client-core,配对用临时连接）、`WebAgentStore`（Task 6）。
- Produces: `<ConnectPage settings store onConnected />`;`App.tsx` 建立 `WebAgentStore` 生命周期(连接成功进入主界面)。

- [ ] **Step 1: 实现 ConnectPage**

`packages/web/src/pages/ConnectPage.tsx`：

```tsx
import { useState } from "react";
import { RelayClient } from "@pocket-code/client-core";
import type { WebSettings } from "../webStorage";

interface Props {
  settings: WebSettings;
  onSave(patch: Partial<WebSettings>): WebSettings;
  onConnect(settings: WebSettings): void;
}

export default function ConnectPage({ settings, onSave, onConnect }: Props) {
  const [mode, setMode] = useState<WebSettings["mode"]>(settings.mode);
  const [serverUrl, setServerUrl] = useState(settings.serverUrl);
  const [relayUrl, setRelayUrl] = useState(settings.relayUrl);
  const [pairCode, setPairCode] = useState("");
  const [status, setStatus] = useState("");
  const paired = !!(settings.relayToken && settings.relayMachineId);

  async function pair() {
    setStatus("配对中…");
    const saved = onSave({ mode: "relay", relayUrl });
    const client = new RelayClient({
      relayUrl: saved.relayUrl,
      machineId: "",
      deviceId: saved.deviceId,
      deviceName: "Pocket Code Web",
      onTokenPersist: (token, machineId) =>
        onSave({ relayToken: token, relayMachineId: machineId }),
    });
    client.connect();
    try {
      await new Promise<void>((res, rej) => {
        client.onopen = () => res();
        client.onerror = (e) => rej(new Error(e.message));
      });
      const resp = await client.pairDevice(pairCode.trim());
      if (!resp.success || !resp.token || !resp.machineId) {
        throw new Error(resp.error || "配对失败");
      }
      client.updateToken(resp.token, resp.machineId);
      setStatus(`已配对:${resp.machineName || resp.machineId}`);
    } catch (err) {
      setStatus(`配对失败:${err instanceof Error ? err.message : String(err)}`);
    } finally {
      client.close();
    }
  }

  function connect() {
    const saved = onSave(mode === "lan" ? { mode, serverUrl } : { mode, relayUrl });
    onConnect(saved);
  }

  return (
    <div className="connect-page">
      <h1>Pocket Code</h1>
      <div className="mode-switch">
        <button className={mode === "lan" ? "active" : ""} onClick={() => setMode("lan")}>局域网直连</button>
        <button className={mode === "relay" ? "active" : ""} onClick={() => setMode("relay")}>Relay 中继</button>
      </div>
      {mode === "lan" ? (
        <label>Daemon 地址
          <input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="ws://192.168.1.10:8787" />
        </label>
      ) : (
        <>
          <label>Relay 地址
            <input value={relayUrl} onChange={(e) => setRelayUrl(e.target.value)} placeholder="wss://aigc.zj.cn/relay" />
          </label>
          <label>配对码
            <input value={pairCode} onChange={(e) => setPairCode(e.target.value)} placeholder="daemon 显示的 8 位码" />
          </label>
          <button onClick={pair} disabled={!relayUrl || !pairCode}>配对</button>
          {paired && <div className="hint">已有配对凭证,可直接连接</div>}
        </>
      )}
      <button className="primary" onClick={connect} disabled={mode === "relay" && !paired && !pairCode}>
        连接
      </button>
      {status && <div className="status">{status}</div>}
      <p className="hint">
        提示:https 部署下浏览器会阻断 ws:// 局域网直连(mixed-content);本地 http 开发页或 relay(wss)不受影响。
      </p>
    </div>
  );
}
```

- [ ] **Step 2: App.tsx 顶层状态机**

```tsx
import { useMemo, useState } from "react";
import ConnectPage from "./pages/ConnectPage";
import { createSettingsStore } from "./webStorage";
import { WebAgentStore } from "./webAgentStore";
import { useWebAgent } from "./useWebAgent";
import type { WebSettings } from "./webStorage";

export default function App() {
  const settingsStore = useMemo(() => createSettingsStore(window.localStorage), []);
  const [store, setStore] = useState<WebAgentStore | null>(null);
  const [tab, setTab] = useState<"chat" | "files">("chat");

  if (!store) {
    return (
      <ConnectPage
        settings={settingsStore.load()}
        onSave={(p) => settingsStore.save(p)}
        onConnect={(s: WebSettings) => {
          const st = new WebAgentStore(s);
          st.connect();
          setStore(st);
        }}
      />
    );
  }
  return <Main store={store} tab={tab} onTab={setTab} onDisconnect={() => { store.disconnect(); setStore(null); }} />;
}

function Main({ store, tab, onTab, onDisconnect }: {
  store: WebAgentStore; tab: "chat" | "files";
  onTab(t: "chat" | "files"): void; onDisconnect(): void;
}) {
  const state = useWebAgent(store);
  return (
    <div className="app">
      <header className="topbar">
        <nav>
          <button className={tab === "chat" ? "active" : ""} onClick={() => onTab("chat")}>Chat</button>
          <button className={tab === "files" ? "active" : ""} onClick={() => onTab("files")}>Files</button>
        </nav>
        <span className={`conn-dot ${state.connected ? "on" : "off"}`} title={state.connected ? "已连接" : "已断开"} />
        <button onClick={onDisconnect}>断开</button>
      </header>
      {state.authError && <div className="auth-error">{state.authError}</div>}
      <main className="content">{tab === "chat" ? <div>Chat(Task 8)</div> : <div>Files(Task 9)</div>}</main>
    </div>
  );
}
```

（`styles.css` 增量:`.connect-page` 居中表单、`.topbar` flex 行、`.conn-dot.on{background:var(--green)}`/`.off{background:var(--red)}`、`.auth-error` 红色横条、`.mode-switch .active{border-color:var(--accent)}`。）

- [ ] **Step 3: 验证**

```bash
pnpm --filter @pocket-code/web test && pnpm --filter @pocket-code/web build
pnpm dev:web  # 手动:打开页面,LAN 模式填本地 daemon 地址点连接,顶栏绿点亮起
```

Expected: 测试与 build 全绿；手动冒烟连接状态条工作。

- [ ] **Step 4: Commit**

```bash
git add packages/web/src
git commit -m "feat(web): 连接/配对页(LAN 直连+relay 配对码)+App 顶层状态机与连接状态条"
```

---

### Task 8: Chat 页（流式渲染 + 工具卡片 + Diff 内联,TDD 纯逻辑）

**Files:**
- Create: `packages/web/src/lineDiff.ts`、`packages/web/src/lineDiff.test.ts`
- Create: `packages/web/src/pages/ChatPage.tsx`
- Modify: `packages/web/src/App.tsx`（Chat tab 挂载 ChatPage）
- Modify: `packages/web/src/styles.css`（消息气泡/工具卡片/diff 行样式增量）

**Interfaces:**
- Consumes: `useWebAgent`/`WebAgentStore.sendMessage`、client-core `Message`/`ToolCall`。
- Produces: `computeLineDiff(oldText: string, newText: string): DiffLine[]`，`DiffLine = { kind: "same" | "add" | "del"; text: string }`。

- [ ] **Step 1: 先写 lineDiff 失败测试**

`packages/web/src/lineDiff.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { computeLineDiff } from "./lineDiff";

describe("computeLineDiff", () => {
  it("marks all lines add for new file (empty old)", () => {
    expect(computeLineDiff("", "a\nb")).toEqual([
      { kind: "add", text: "a" },
      { kind: "add", text: "b" },
    ]);
  });

  it("computes minimal add/del around common lines", () => {
    expect(computeLineDiff("a\nb\nc", "a\nx\nc")).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "x" },
      { kind: "same", text: "c" },
    ]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @pocket-code/web test
```

Expected: FAIL —— `Cannot find module './lineDiff'`。

- [ ] **Step 3: 实现 lineDiff（LCS 动态规划,足够 MVP 文件规模）**

`packages/web/src/lineDiff.ts`：

```ts
// ── 行级 diff(LCS DP)。MVP 规模(几千行内)足够;超大文件截断由调用方负责。 ──

export interface DiffLine {
  kind: "same" | "add" | "del";
  text: string;
}

export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText === "" ? [] : oldText.split("\n");
  const b = newText === "" ? [] : newText.split("\n");
  const m = a.length, n = b.length;
  // dp[i][j] = a[i:] 与 b[j:] 的 LCS 长度
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] }); i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: "del", text: a[i] }); i++;
    } else {
      out.push({ kind: "add", text: b[j] }); j++;
    }
  }
  while (i < m) out.push({ kind: "del", text: a[i++] });
  while (j < n) out.push({ kind: "add", text: b[j++] });
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @pocket-code/web test
```

Expected: lineDiff 2 例 PASS。

- [ ] **Step 5: 实现 ChatPage**

`packages/web/src/pages/ChatPage.tsx`：

```tsx
import { useEffect, useRef, useState } from "react";
import type { Message, ToolCall } from "@pocket-code/client-core";
import { computeLineDiff } from "../lineDiff";
import { useWebAgent } from "../useWebAgent";
import type { WebAgentStore } from "../webAgentStore";

export default function ChatPage({ store }: { store: WebAgentStore }) {
  const state = useWebAgent(store);
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [state.messages]);

  function send() {
    const content = input.trim();
    if (!content || !state.connected) return;
    store.sendMessage(content);
    setInput("");
  }

  return (
    <div className="chat-page">
      <div className="messages">
        {state.messages.map((m) => (
          <MessageRow key={m.id} message={m} />
        ))}
        {state.phase !== "idle" && <div className="phase-indicator">{PHASE_LABEL[state.phase]}</div>}
        <div ref={bottomRef} />
      </div>
      <div className="composer">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
          }}
          placeholder={state.connected ? "输入消息,Enter 发送" : "未连接"}
        />
        <button onClick={send} disabled={!state.connected || !input.trim()}>发送</button>
      </div>
    </div>
  );
}

const PHASE_LABEL: Record<string, string> = {
  connecting: "连接中…", thinking: "正在思考…", generating: "正在回复…",
  "tool-calling": "准备执行", "tool-running": "执行中",
};

function MessageRow({ message }: { message: Message }) {
  return (
    <div className={`msg ${message.role}`}>
      {message.thinking && <details className="thinking"><summary>思考过程</summary><pre>{message.thinking}</pre></details>}
      {message.toolCalls?.map((tc, i) => <ToolCard key={tc.callId ?? i} tool={tc} />)}
      {message.content && <div className="bubble">{message.content}</div>}
    </div>
  );
}

function ToolCard({ tool }: { tool: ToolCall }) {
  const result = tool.result as
    | { success?: boolean; newContent?: string; oldContent?: string; path?: string; isNew?: boolean }
    | undefined;
  const isDiff = tool.toolName === "writeFile" && result?.success && typeof result.newContent === "string";
  return (
    <div className="tool-card">
      <div className="tool-head">
        <span className="tool-name">⚙ {tool.toolName}</span>
        <span className="tool-status">{tool.result === undefined ? "running…" : "done"}</span>
      </div>
      {isDiff ? (
        <DiffBlock path={result!.path || String(tool.args.path ?? "unknown")}
                   oldContent={result!.oldContent || ""} newContent={result!.newContent!} />
      ) : (
        tool.result !== undefined && (
          <pre className="tool-result">{typeof tool.result === "string"
            ? tool.result.slice(0, 500)
            : JSON.stringify(tool.result, null, 2).slice(0, 500)}</pre>
        )
      )}
    </div>
  );
}

function DiffBlock({ path, oldContent, newContent }: { path: string; oldContent: string; newContent: string }) {
  const lines = computeLineDiff(oldContent, newContent);
  return (
    <div className="diff-block">
      <div className="diff-path">{path}</div>
      <pre>
        {lines.map((l, i) => (
          <div key={i} className={`diff-line ${l.kind}`}>
            {l.kind === "add" ? "+ " : l.kind === "del" ? "- " : "  "}{l.text}
          </div>
        ))}
      </pre>
    </div>
  );
}
```

`App.tsx` 的 Chat tab 占位替换为 `<ChatPage store={store} />`。`styles.css` 增量：`.msg.user .bubble` 右对齐蓝底、`.msg.assistant .bubble` 左对齐面板底、`.tool-card` 边框卡片、`.diff-line.add{color:var(--green)}`/`.del{color:var(--red)}`、`.messages{flex:1;overflow-y:auto}`、`.composer{display:flex;gap:8px;padding:12px}`。

- [ ] **Step 6: 验证**

```bash
pnpm --filter @pocket-code/web test && pnpm --filter @pocket-code/web build
pnpm dev:web  # 手动:连上 daemon 发一条会改文件的消息,确认流式文本/工具卡片/diff 渲染
```

- [ ] **Step 7: Commit**

```bash
git add packages/web/src
git commit -m "feat(web): Chat 页(流式渲染+工具卡片+writeFile diff 内联,lineDiff TDD 2 例)"
```

---

### Task 9: Files 页（文件树 + 文件查看）

**Files:**
- Create: `packages/web/src/pages/FilesPage.tsx`
- Modify: `packages/web/src/App.tsx`（Files tab 挂载）
- Modify: `packages/web/src/styles.css`（两栏布局/树缩进样式增量）

**Interfaces:**
- Consumes: `store.conn.listFiles(path)` → `{success?, items?: Array<{name: string; type: "directory" | "file"}>, error?}`；`store.conn.readFile(path)` → `{success?, content?: string, error?}`（形状来自 wire `FileListMsg`/`FileContentMsg` + agent-core listFiles 工具:items 仅 name+type,子路径由调用方拼接）。

- [ ] **Step 1: 实现 FilesPage**

`packages/web/src/pages/FilesPage.tsx`：

```tsx
import { useEffect, useState } from "react";
import type { WebAgentStore } from "../webAgentStore";

interface Entry { name: string; type: "directory" | "file" }

export default function FilesPage({ store }: { store: WebAgentStore }) {
  const [dir, setDir] = useState(".");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState("");
  const [filePath, setFilePath] = useState<string | null>(null);
  const [content, setContent] = useState("");

  async function loadDir(path: string) {
    setError("");
    try {
      const resp = await store.conn.listFiles(path);
      if (resp.success === false) throw new Error(resp.error || "列目录失败");
      setDir(path);
      setEntries((resp.items ?? []) as Entry[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function openFile(path: string) {
    setError("");
    try {
      const resp = await store.conn.readFile(path);
      if (resp.success === false) throw new Error(resp.error || "读文件失败");
      setFilePath(path);
      setContent(String(resp.content ?? ""));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => { void loadDir("."); }, []);

  const join = (name: string) => (dir === "." ? name : `${dir}/${name}`);
  const parent = () => (dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : ".");

  return (
    <div className="files-page">
      <div className="file-tree">
        <div className="dir-bar">
          <button onClick={() => void loadDir(parent())} disabled={dir === "."}>↑</button>
          <span className="dir-path">{dir}</span>
          <button onClick={() => void loadDir(dir)}>刷新</button>
        </div>
        {error && <div className="file-error">{error}</div>}
        <ul>
          {entries.map((e) => (
            <li key={e.name}>
              <button className={`entry ${e.type}`}
                onClick={() => (e.type === "directory" ? void loadDir(join(e.name)) : void openFile(join(e.name)))}>
                {e.type === "directory" ? "📁" : "📄"} {e.name}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="file-viewer">
        {filePath ? (<><div className="viewer-path">{filePath}</div><pre>{content}</pre></>)
          : <div className="viewer-empty">选择文件查看内容</div>}
      </div>
    </div>
  );
}
```

`App.tsx` Files tab 占位替换为 `<FilesPage store={store} />`。`styles.css` 增量：`.files-page{display:flex;flex:1;min-height:0}`、`.file-tree{width:280px;overflow-y:auto;border-right:1px solid var(--border)}`、`.file-viewer{flex:1;overflow:auto}`、`.file-viewer pre{font-family:var(--mono);padding:12px}`。

- [ ] **Step 2: 验证**

```bash
pnpm --filter @pocket-code/web test && pnpm --filter @pocket-code/web build
pnpm dev:web  # 手动:Files tab 浏览目录/打开文件/进错误路径看错误条
```

- [ ] **Step 3: Commit**

```bash
git add packages/web/src
git commit -m "feat(web): Files 页(list-files/read-file RPC 消费,目录导航+文件查看)"
```

---

### Task 10: 收尾——plan.md 更新 + 全仓门禁 + 人工验收

**Files:**
- Modify: `plan.md`（已完成表加 P10 行;待办第 1 项替换为 P11;架构图 App 框旁注 Web）
- Test: 全仓门禁 + 双路径人工验收

- [ ] **Step 1: plan.md 更新**

「已完成」表追加一行：

```markdown
| P10 | client-core 同构包(三模块正典迁移+去 RN 化)+Web 端 Chat/Files/Diff | specs+plans/2026-07-10-p10 |
```

「待办」第 1 项替换为：

```markdown
1. **P11:RN App 切换消费 client-core**,删除三个冻结副本(services/serverConnection.ts、services/relayClient.ts、hooks/chatReducer.ts 及其测试)。
```

- [ ] **Step 2: 全仓门禁**

```bash
pnpm build && pnpm test:all && pnpm typecheck:app
```

Expected: 全绿（client-core 30 例、web 6 例入列;app 71 例不回归）。

- [ ] **Step 3: 人工验收（两条路径 × Chat+Files+Diff）**

1. LAN:`pnpm dev:server`（或真 daemon）+ `pnpm dev:web`,LAN 模式连接 → 发消息看流式/工具卡片/diff → Files 浏览与查看。
2. Relay:本地起 relay(`pnpm dev:relay`,设 RELAY_SECRET)+daemon 注册 → Web relay 模式配对码配对 → 同上跑通 Chat+Files。
3. 断开 daemon 验证重连指示与 authError 提示。

- [ ] **Step 4: Commit**

```bash
git add plan.md
git commit -m "docs: P10 完成态同步(plan.md 已完成表+P11 待办替换)"
```

---

## Self-Review 记录

- **Spec 覆盖**:2.1-2.4(Task 1-3)、3.1 连接页(Task 7)/Chat+Diff(Task 8)/Files(Task 9)、3.2 错误处理(Task 6/7 状态条+authError;mixed-content 提示在 ConnectPage 文案)、4 测试(各 task 步骤+Task 10 门禁与人工验收)、5 冻结(Task 4)、P11 待办(Task 10)。无缺口。
- **占位符**:无 TBD/TODO;所有代码步骤含完整代码。
- **类型一致性**:`WebSettings`/`AgentState`/`DiffLine`/`Entry` 前后引用一致;`onTokenPersist` 签名 Task 2 定义、Task 7 消费一致;`Message`/`ToolCall` 均从 client-core 导入。
