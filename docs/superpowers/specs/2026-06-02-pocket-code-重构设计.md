# Pocket Code 重构设计

> 日期：2026-06-02
> 状态：已与用户确认架构与 MVP 边界，待 review → 实现计划
> 一句话定位：**个人编程代理。手机为主控端，能改代码、能真正跑起来、能直接在手机上看到运行效果（尤其前端页面）。代码同步与运行环境可靠。SaaS 多租户后置。**

---

## 1. 背景与现状

通过对当前 monorepo 的逐包审计（wire / server / daemon / relay / app / 原生终端），核实结论如下：

**整体完成度 ≈ 62–68%，是"补完 + 重构收敛"而非重写。**

| 子系统 | 完成度 | 评价 |
|---|---|---|
| server / AI agent 核心 | ~78% | 最完整，多模型流式 + 15 工具 agentic loop + session + abort，**项目真正资产** |
| app / UI | ~78% | 对话/Diff/终端/文件/预览四 Tab 已接好，暗色主题完整 |
| app / 客户端逻辑 | ~72% | 三种模式 service 都在；本地↔云目前只有**单向同步**（远端→本地） |
| daemon | ~72% | 配对/重连/handler 池设计干净；不校验 relay 消息、send 失败静默丢 |
| relay | ~72% | 纯转发设计好；ws:// 明文、不验 JWT、可被恶意 daemon 伪造响应、requestMap 内存泄漏 |
| 原生终端 / 端侧执行 | ~68% | libvterm 模块工程化扎实；端侧 shell 执行受 Android SELinux 限制、WASM 引擎未做 |
| server / 基础设施 | ~65% | Docker 隔离架构好但默认关；配额半残（仅 API 次数生效）；凭证明文 |
| wire / 协议 | ~35% | **死代码**：除自身 index.ts 外零运行时引用，协议在 3 处重复定义 |

**已核实的关键事实（含纠正 reader 误报）：**

- ✅ `DOCKER_ENABLED` 默认 `false` → 云模式下 `runCommand` 直接在宿主机裸跑（仅 SaaS 场景致命，本设计后置）。
- ✅ App 的 `expo-file-system` 迁移只做了一半：`gitService.ts` 用新 API（`Paths/Directory`），`fileTransfer.ts` 仍用已移除的 `FileSystemUploadType/cacheDirectory`。
- ✅ `wire` 是死代码，协议三处分裂（wire / server `wsSchemas.ts` / app 手搓 envelope）。
- ✅ daemon 配对测试断言过时（断言 `/^\d{6}$/`，实际生成 8 位字母数字），CI 必挂。
- ✅ 三套并存的 agent 执行路径：server AI-SDK loop / server CLI 子进程(cliRunner) / app 端 geek-mode loop。
- ❌（误报已纠正）原生终端模块并非空目录，真模块在 `packages/app/modules/pocket-terminal-module/`（cpp/android/ios/src 齐全），空的是根目录 `/modules` 残留。
- ❌（误报已纠正）`crypto` 未导入会崩溃——Node 20/22 有全局 WebCrypto，不崩。
- ❌（误报已纠正）`libproot.so` 已打包，真问题是 Android 10+ SELinux 运行时限制。

**架构判断**：5 包结构本身合理；relay/daemon 通过 `import` 复用同一套 server `messageHandler` 是加分项。真正的"过度工程"是**三套并存的 agent loop** + **死掉的 wire 包** + **同时押注三条产品路线却都没跑通**。最致命：每个子系统单看完成度不低，但**没有任何一条端到端链路被验证跑通过，零集成测试**。

---

## 2. 目标与非目标

### 2.1 目标

1. **改代码 → 跑起来 → 手机看到效果** 这条闭环端到端跑通（尤其前端页面）。
2. 复用成熟 CLI agent（claude-code 优先，codex/gemini 随后）**减少自研 agent 逻辑**。
3. 纯手机端侧具备**独立运行的 agent 能力**（离线/隐私场景）。
4. 代码在开发机与手机间可靠存储与切换同步，**不污染用户 git 分支**。
5. 收编"三套 agent loop"技术债；让 `wire` 成为协议单一真相源。

### 2.2 非目标（明确后置）

- SaaS 多租户云托管、Docker 沙箱默认开、配额完整化、凭证加密、计费——**全部后置**（代码保留不删，gate 关闭）。
- 端侧通用 Linux shell 执行（proot/Alpine over SELinux）——**降级为后置独立 spike，不在关键路径**。
- iOS 原生终端 / 端侧执行（iOS 走配对开发机模式）。

---

## 3. 核心架构

### 3.1 两种 agent 形态 + 一个归一化契约

复杂性根源：三套 loop 各自向 UI 吐不同格式事件。**解药是定义一个"归一化 AgentEvent 流"作为 App 唯一消费的契约**，App 只认这个流、不关心谁产生。下面挂两种 agent 实现，UI 与 agent 彻底解耦。

```
┌──────────────── 手机 App（主控 + 渲染）────────────────┐
│  Chat / Diff / Terminal / Files / Preview              │
│     ▲ 只消费「归一化 AgentEvent 流」                     │
│  ┌──┴──────── AgentSession 接口 ─────────────────────┐ │
│  │  send(msg,imgs) → stream<AgentEvent>;  abort()    │ │
│  └──┬─────────────────────────────────┬──────────────┘ │
└─────┼────────────（远程 LAN/Relay）────┼（in-process）──┘
   ┌──▼───────────────────────────┐  ┌──▼────────────────────┐
   │ 开发机 Daemon                  │  │ BuiltinAgent (跑手机)   │
   │  DelegatedCliAgent            │  │  我们的同构 loop        │
   │   ├ claude-code  ┐            │  │   └→ RuntimeBackend     │
   │   ├ codex        ├ adapter→事件│  │       = DeviceBackend   │
   │   └ gemini-cli   ┘            │  │       (expo-fs/WASM)    │
   │  Workspace RPC + dev server   │  └─────────────────────────┘
   │  (可选) BuiltinAgent on daemon │
   └───────────────────────────────┘
```

### 3.2 归一化 AgentEvent 协议（进 `wire`，单一真相源）

判别联合（按 `type`），覆盖三种来源（claude-code NDJSON / 其他 CLI / BuiltinAgent loop）的超集：

| type | 载荷 | 说明 |
|---|---|---|
| `text-delta` | `{ text }` | 回复正文流 |
| `reasoning-delta` | `{ text }` | 思维链流（DeepSeek R1 / claude-code thinking） |
| `tool-call` | `{ callId, name, args }` | 工具调用开始 |
| `tool-result` | `{ callId, result, isError }` | 工具结果 |
| `file-changed` | `{ path, changeType: created\|modified\|deleted, oldContent?, newContent? }` | 文件变更（驱动 Diff/FileChangeSummary） |
| `command-output` | `{ callId, chunk, stream: stdout\|stderr }` | 命令实时输出 |
| `process-started` | `{ processId, command, cwd }` | 长进程启动 |
| `process-exited` | `{ processId, exitCode }` | 长进程退出 |
| `preview-available` | `{ url, source: dev-server\|static }` | 可预览的 URL（触发 Preview Tab） |
| `model-selected` | `{ modelKey, reason }` | 智能路由选模结果 |
| `usage` | `{ inputTokens, outputTokens }` | token 统计 |
| `done` | `{}` | 本轮结束 |
| `error` | `{ message, code? }` | 错误 |

适配器各自把原生输出归一化到此协议；UI 渲染层只实现一次。

### 3.3 `AgentSession` 接口

```ts
interface AgentSession {
  readonly id: string;
  send(input: { text: string; images?: ImageRef[] }): AsyncIterable<AgentEvent>;
  abort(): void;
}
```

App 拿到的永远是一个 `AgentSession`，背后是远程（CLI 委托，经 transport）还是本地（BuiltinAgent，in-process）对 UI 透明。

### 3.4 实现一：`DelegatedCliAgent`（开发机端，复用 CLI 工具）—— 减少逻辑的关键

- 在开发机 spawn `claude-code`（MVP）/ `codex` / `gemini-cli`；**agent 智能、规划、工具调用、改文件全在 CLI 内部**，我们写**零 agent 逻辑**。
- 我们只写一个 **`CliAgentAdapter`**：

```ts
interface CliAgentAdapter {
  id: 'claude-code' | 'codex' | 'gemini-cli';
  buildSpawn(input, ctx): { cmd: string; args: string[]; env: Record<string,string>; cwd: string };
  parseChunk(line: string): AgentEvent[];   // 原生 NDJSON/行 → 归一化事件
  supportsResume: boolean;
}
```

- 现有 `cliRunner.ts` 即雏形（已有 claude-code + gemini，但解析器近乎重复）→ 抽成上面这个接口，每个工具一个适配器，消除重复。
- runtime 天然就是开发机文件系统（CLI 在 cwd 里直接改）。

### 3.5 实现二：`BuiltinAgent`（端侧独立，一套同构核心）—— 后置但先定接口

- 我们自己的 loop：模型 API 流式 + 工具分发，工具打到 `RuntimeBackend`，emit 归一化 AgentEvent。
- **把 `server/agent.ts` 与 app geek-mode loop 合并成一套同构 TS 核心**（消灭真正的重复）。
- 计划独立成 `@pocket-code/agent-core`（isomorphic）：
  - 依赖抽象的 `ModelClient`（流式聊天 + tool-calling）与 `RuntimeBackend`，不直接绑 Node 专有库。
  - `ModelClient` 两实现：Node 端用 Vercel AI SDK；RN 端用现有 `aiClient.ts` 的 XHR-SSE（Hermes 对 fetch 流式不可靠）。
  - 两个家：手机（端侧模式）/ 开发机 daemon（无 CLI 订阅但有 API Key 的用户）。**一份代码。**

### 3.6 `RuntimeBackend`（供 BuiltinAgent 用的执行/文件基底）

```ts
interface RuntimeBackend {
  readFile(path): Promise<Uint8Array | string>;
  writeFile(path, content): Promise<void>;
  listFiles(path): Promise<FileEntry[]>;
  exec(cmd, opts): Promise<{ stdout: string; stderr: string; exitCode: number }>; // 一次性
  startProcess(cmd, opts): Promise<{ processId: string }>;                         // 常驻
  killProcess(processId): Promise<void>;
  onProcessOutput(cb): Unsubscribe;
  getPreviewUrl(port): Promise<string>;   // 返回手机可达的 URL（localhost / LAN / 隧道）
}
```

- `DeviceBackend`（手机）：fs 用 expo-fs；前端 build/preview 用 WebView 内 esbuild-wasm；通用 shell 走端侧 spike（后置）。
- `RemoteRuntimeBackend`（手机→开发机）：把上述操作 RPC 到开发机的 **Workspace RPC**。

> 注意：`DelegatedCliAgent` **不经** RuntimeBackend 执行工具（CLI 自己干），但仍需开发机的 **Workspace RPC**（文件浏览 / git 同步 / 预览隧道）。即 daemon 始终暴露 Workspace RPC，`RuntimeBackend.exec` 只被 BuiltinAgent 使用。

### 3.7 Transport（传输层）

`AgentSession` 与 Workspace RPC 走三种 transport：

- **LAN-direct**：手机 ↔ 开发机 WebSocket 直连（最快）。
- **Relay**：手机 ↔ VPS Relay ↔ 开发机 Daemon（中继 envelope，远程不暴露端口）。
- **in-process**：端侧 BuiltinAgent，无网络。

---

## 4. 代码存储与同步：Git 影子快照 ref（零污染）

### 4.1 真相源与镜像

- **真相源 = 当前"主运行后端"的 workspace，但全程 git 版本化**，可携带、可切换。
- **手机永远保留一份本地 clone**（isomorphic-git，已实现）：支撑离线浏览、端侧 agent、前端预览。
- **切换同步 = git**：机↔手机切换时 `pull` 最新；冲突交给 git 三方合并；`.gitignore` 天然挡 node_modules。

### 4.2 零污染机制（影子快照 ref）

同步**绝不**碰用户分支/HEAD/暂存区，只活在私有命名空间 `refs/pocket-code/*`：

```bash
export GIT_INDEX_FILE=.git/pocket-code/index   # ① 私有 index，不碰用户暂存区
git add -A                                      # 快照工作区(含未提交/未跟踪非忽略文件)
TREE=$(git write-tree)
PARENT=$(git rev-parse -q --verify refs/pocket-code/worktree)
COMMIT=$(git commit-tree $TREE ${PARENT:+-p $PARENT} -m "pocket snapshot")
git update-ref refs/pocket-code/worktree $COMMIT   # ② 只动私有 ref
# 用户的 refs/heads/*、HEAD、.git/index、提交历史 —— 全程零改动
```

- 只传**增量 pack**给手机；手机把该 tree checkout 到本地工作副本。
- 真实 commit 只在用户（或用户明确让 claude-code）主动提交时发生——正常开发，非同步噪音；真实 commit 也顺带同步，手机能看到真实历史 + 最新工作区快照。
- 同步对象可一键清除：`git update-ref -d refs/pocket-code/worktree && git gc`。

### 4.3 活动会话快路径

git 负责粗粒度/持久同步；**活动会话只把"本轮刚改的几个文件"经 transport 即时推送**（复用 `file-changed` 事件 + 现有 `workspaceSync`），保证手感，不必每轮 commit。

---

## 5. 预览：让手机看到运行效果

### 5.1 核心洞察：分开「跑进程」和「浏览器渲染」

| "运行"的含义 | 需要 | 手机可行性 |
|---|---|---|
| 前端页面渲染（HTML/CSS/JS/ESM 在浏览器跑） | 一个 WebView（本身是完整浏览器，支持 WASM） | ✅ 完全可行，无需 Node、绕开 SELinux |
| 跑常驻进程（vite dev / node / python / 测试） | 真正的 Node/Python 运行时 + node_modules | ⚠️ 跑在手机 = SELinux 难题 + 同步原生二进制（不兼容 ARM-Android），双输 |

### 5.2 中继 HTTP 隧道（让"看 Node 效果"绕开本地 Linux 坑）

```
手机 WebView ──HTTP──► VPS Relay ──隧道──► 开发机 Daemon ──► localhost:3000 (vite/next/node)
                                                       (完整 Node 环境，零限制)
```

- dev server **跑在开发机**（满血），手机是它的"远程浏览器"。局域网时直连 `http://机器IP:端口`；远程时经 Relay HTTP 隧道透传。**手机端零 Node。**
- 隧道在 daemon 的持久 WS 上多路复用 HTTP 请求：手机→relay→daemon→`localhost:port`→流式回传。
- **后果（优先级重排）**：既然"看 Node 应用效果"靠"开发机跑 + 隧道"即可，**端侧通用 Linux 执行彻底离开关键路径**，降为离线 fallback。

> 工程细节：vite HMR 走 WebSocket。**MVP 先做整页刷新预览（纯 HTTP 隧道）**；HMR（WS upgrade 隧道）后置。

### 5.3 离线前端：WebView 内 esbuild-wasm

模式 C（离线/纯端侧前端）：源码在手机本地 clone → **WebView 内**载入 esbuild-wasm 现场打包 → 同一 WebView 渲染。

> 关键：WASM 跑在 WebView（真浏览器）里，**不是** RN 的 Hermes 引擎（Hermes 不支持 WASM）。

---

## 6. 三种模式的完整闭环

| 模式 | 改代码 | 真相源/同步 | 跑 | 看效果 | MVP? |
|---|---|---|---|---|---|
| **A. 配对开发机（主力）** | 开发机 claude-code | 开发机 git 仓 ↔ 手机 clone（影子快照） | 进程跑**开发机** | WebView → dev server URL（局域网直连 / 中继 HTTP 隧道） | ✅ MVP |
| **B. 前端·边改边看** | 开发机 claude-code | 开发机 build 产物/源码 → 同步手机 | 前端**渲染在手机** WebView | 手机本地 `file://` / in-app 静态服务，离线可看 | ❌ 后置（依赖 esbuild-wasm，随 C；其"开发机 build→同步 dist→手机静态预览"变体可后续从 A 低成本派生） |
| **C. 纯端侧（离线/隐私）** | 手机 BuiltinAgent | 手机本地（全本地） | 前端→WebView；shell→DeviceBackend(spike) | 手机本地 | ❌ 后置 |

三种模式共用：**同一套归一化 AgentEvent UI** + **同一个 git 同步骨干** + **同一个 WebView 预览层**。差异只在 agent 实现（CLI 委托 vs Builtin）与 RuntimeBackend（开发机 vs 端侧）。

---

## 7. 包结构与协议统一

### 7.1 `wire` 成为单一真相源

- 把归一化 AgentEvent、AgentSession 消息、Workspace RPC、Relay envelope/pairing、隧道帧全部定义在 wire。
- server 改为从 `@pocket-code/wire` 导入，**删除重复的 `wsSchemas.ts`**。
- app/daemon/relay 在消息边界 `safeParse` 校验（修复 relay/daemon "raw JSON.parse + 手工字段检查"的脆弱性）。
- 补齐所有 response/事件 schema（当前只有 inbound 业务消息被 schema 化）。

### 7.2 包职责（目标态）

| 包 | 职责 | 本次变化 |
|---|---|---|
| `wire` | 协议单一真相源（含 AgentEvent / RPC / 隧道 / 配对） | 大幅扩充，被全员真正导入 |
| `agent-core`（新） | isomorphic BuiltinAgent + ModelClient 抽象 | 合并 server/agent.ts + app geek-loop（后置实现，MVP 先定接口） |
| `server` | Workspace RPC + DelegatedCliAgent + (可选)agent-core 宿主 | 退化为运行时服务；CLI 适配器化；删 wsSchemas 重复 |
| `daemon` | 中继连接 + 配对 + Workspace RPC + 隧道端点 | 加隧道；校验 wire 消息；修 send 失败静默丢 |
| `relay` | 纯转发 + 配对 + HTTP 隧道转发 | 加隧道转发；wire 校验；修 requestMap 泄漏；远程模式安全加固 |
| `app` | 主控 UI + AgentSession 消费 + git clone + WebView 预览 | 修 expo-fs 迁移；统一 AgentSession；esbuild-wasm 预览（随 C） |

---

## 8. 安全与清理（按模式裁剪）

仅与本设计相关的、需在对应阶段处理的项：

**MVP 必修（真 bug）：**
- 修 `fileTransfer.ts` 的 `expo-file-system` 迁移（对齐 `gitService.ts` 的 `Paths/Directory` 新 API）+ `expo-notifications` 权限 API。
- 修过时的 daemon 配对测试（`/^\d{6}$/` → 8 位字母数字）。
- 接好后台任务通知（`sendLocalNotification` 已存在但未被调用）。

**MVP 远程模式加固（模式 A 经中继时）：**
- relay 强制 wss:// 或明确文档化"nginx 终止 TLS、relay 不得直接暴露"。
- daemon 与其响应的身份绑定，防恶意 daemon 伪造他人 requestId。
- relay `requestMap` 加 per-request 超时，修内存泄漏。
- daemon 校验 relay 消息（wire safeParse）；`connection.send()` 返回值检查 + 重试/排队。

**后置（仅 SaaS 才需要，本设计不做）：**
- `DOCKER_ENABLED` 默认开 + `runCommand` 沙箱化 + 网络隔离 + 只读 rootfs。
- 配额完整化（container_time/disk/maxSessions）+ 凭证加密 + 审计日志。

**清理：**
- 删除根目录残留空 `/modules`。
- plan.md 复选框对齐真实交付，或并入本文档。

---

## 9. MVP 边界

**MVP 收纳：**
1. 模式 A（配对开发机 + claude-code + 局域网/中继）跑通**端到端闭环**：连接 → 发编码请求 → claude-code 改文件 → 手机看 Diff/终端输出 → 启动 dev server → 手机预览看到效果。
2. 归一化 AgentEvent 协议进 wire；server 导入 wire、删 wsSchemas 重复。
3. `cliRunner` → `CliAgentAdapter`（claude-code 适配器）。
4. git 影子快照同步（零污染）+ 活动文件快路径。
5. 中继 HTTP 隧道预览（整页刷新）+ 局域网直连预览。
6. 修真 bug（expo-fs 迁移、过时配对测试、通知接线）。
7. 一条 server 端 agent 闭环集成测试 + 最小 CI（构建全部包 + 跑现有单测）。

**MVP 后置：**
- 模式 C 端侧 BuiltinAgent + `agent-core` 实现 + esbuild-wasm 预览。
- HMR 热更新隧道（WS upgrade）。
- codex / gemini-cli 适配器。
- 端侧通用 shell 执行 spike（proot/Alpine over SELinux 真机验证）。
- SaaS/Docker/配额/凭证加密/计费 全部押后。

---

## 10. 风险与待验证

| 风险/待验证 | 缓解 |
|---|---|
| 中继 HTTP 隧道把 dev server 透传给手机是否顺畅（含静态资源、相对路径、CORS） | MVP 先验最简单 vite/next 静态预览；隧道层做路径前缀重写 |
| claude-code NDJSON 输出格式稳定性（版本变动、ANSI、嵌入换行） | adapter 容错解析 + 非 JSON 行降级为 text-delta；锁定 claude-code 版本 |
| 影子快照在手机侧 checkout 与手机本地未提交编辑冲突 | MVP 假设"同一时刻只一侧编辑"；git 三方合并兜底；冲突时提示用户 |
| `agent-core` 同构（Node + RN）下模型流式差异 | 抽象 `ModelClient`，两实现；MVP 不依赖此项 |
| 端侧 shell（proot/SELinux）能否跑通 | 已移出关键路径；后置独立 spike，失败也只影响模式 C 的 shell 能力 |

---

## 11. 测试策略

- **单测**：CliAgentAdapter 解析（claude-code NDJSON → AgentEvent）、wire schema 往返、影子快照 ref 不污染分支（断言 refs/heads、HEAD、index 未变）。
- **集成测试**：server/daemon 端 DelegatedCliAgent 全闭环（发消息 → 文件变更事件 → done）；relay+daemon 往返（配对 → 请求 → 流 → done）；HTTP 隧道往返。
- **最小 CI**：每次 push 构建 wire→server→daemon/relay→agent-core，跑全部单测（先修过时的配对测试）。
- **真机验证清单（MVP 验收）**：
  1. 手机局域网直连开发机 → 发"创建一个 vite + react 页面并启动 dev server" → 看到 Diff、终端输出、`preview-available`。
  2. 点开 Preview Tab → WebView 加载开发机 dev server → 看到页面。
  3. 切到中继远程 → 同样能预览（整页刷新）。
  4. 同步往返后 `git status` 干净、`git log` 无 pocket 噪音 commit、`git for-each-ref refs/pocket-code/` 可见且可清除。
