# P6b App 切归一化 AgentEvent 设计

> 日期：2026-07-05
> 状态：已与用户确认（geek 回调转 AgentEvent、App 只用类型不做运行时校验、协议直接切不留兼容层）
> 上游：`2026-06-02-pocket-code-重构设计.md` §3.2/§3.3（归一化 AgentEvent 是 App 唯一消费契约）；P3b 的灰度桥接在本设计中移除。
> 一句话定位：**完成灰度迁移的"后一半"——server 事件源头直接产归一化 AgentEvent、删 bridge、出站消息 schema 进 wire、App 拆 useAgent 巨石并统一云端/geek 两套 UI 更新逻辑。**

---

## 1. 背景与现状

P3b 采用灰度策略：CLI 路径内部产 `AgentEvent`，经 `cli/bridge.ts` 转回旧 `StreamEvent` 给 messageHandler/App，App 零改动。当前遗留：

- `server/agent.ts:145` 仍定义旧 `StreamEvent`；AI-SDK 路径（fullStream 循环）直接产旧格式；gemini-cli 旧解析路径也产旧格式。
- wire 的 `AgentEvent` 只在 server 内部（CLI 路径）使用，**App 消费的仍是旧字段名**（`toolName`/`action`/`model`/`error`/`promptTokens`）。
- 出站控制响应（`auth`/`session`/`file-list`/`sync-manifest` 等 11 种）无 schema，是"协议单一真相源"的最后缺口（P2 时明确留待"被真正消费时"再加）。
- `app/hooks/useAgent.ts` 已 1207 行，混杂：传输（WS/Relay + 重连）、鉴权握手、云端事件 reducer、geek 端侧 loop、`_reqId` RPC、离线队列、通知、历史持久化。云端与 geek 各一套 `setMessages` 更新逻辑。

## 2. 目标与非目标

### 2.1 目标

1. server 所有 agent 执行路径（AI-SDK / claude-code / gemini-cli）的事件源头直接产 wire `AgentEventType`；**删除 `StreamEvent` 与 `cli/bridge.ts`**。
2. 出站消息 schema 进 wire（`ServerOutbound` 联合），server 构造处类型约束，App `import type` 对齐。
3. App 拆 `useAgent`：传输层（`serverConnection.ts`）/ 纯函数事件 reducer（`chatReducer.ts`）/ 瘦组合 hook 三层；**对外 API 面不变，App.tsx 零改动**。
4. geek 模式回调适配为 AgentEvent，与云端共用同一个 reducer——UI 更新逻辑只写一次。

### 2.2 非目标（明确后置）

- `aiClient.ts` 重写 / `agent-core` 同构包（模式 C）——后置不变，本设计只在其回调外加适配层。
- App 运行时 zod 校验（已决策：type-only，App 是信任客户端，server/daemon/relay 已在各自边界校验）。
- 旧协议兼容/双发（已决策：直接切，monorepo 同源部署，server 与 App 同时升级）。
- `command-output`/`process-started`/`process-exited`/`preview-available`/`model-selected` 之外的新 UI 消费者——reducer 对无 UI 消费者的事件类型显式忽略，等对应 Tab 接入时再处理。

## 3. 设计

### 3.1 服务端：事件源头归一化

**`agent.ts`**：
- 删除 `StreamEvent` 类型定义；`runAgent` 签名改 `onEvent: (event: AgentEventType) => void`（从 `@pocket-code/wire` 导入）。
- AI-SDK fullStream 循环改发归一化事件：
  - `tool-call` → `{ callId: part.toolCallId, name: part.toolName, args: part.args }`
  - `tool-result` → `{ callId: part.toolCallId, result: part.result }`（`isError` 省略——AI SDK 工具错误以 result 内容表达，与现状一致）
  - `file-changed` → `{ path, changeType: isNew ? "created" : "modified" }`
  - `error` → `{ message: String(part.error) }`；`usage` → `{ inputTokens, outputTokens }`；`model-selected` → `{ modelKey, reason }`
- 事件映射抽成可测纯函数（fullStream part → AgentEvent[]），循环只负责迭代与累积 fullText。

**`cliRunner.ts`**：
- claude-code 路径：删 bridge 层，`runCliAgent` 产出的 AgentEvent 直接透传给 `onEvent`。
- gemini-cli 路径：`parseGeminiLine`（或等价逻辑）改产 AgentEvent，`tool-call`/`tool-result` 无原生 callId 则按序合成（`gm_<n>`）。
- **删除 `cli/bridge.ts` 与 `cli/bridge.test.ts`**。

**`messageHandler.ts`**：
- 流式事件透传不变（`send(event)`）。
- `tool-exec` 响应从 `{type:"tool-result", callId, toolName, result}` 改为 AgentEvent 形状 `{type:"tool-result", callId, result}`（App geek 路径按 callId resolve，`toolName` 字段本就未被读取）。
- 出站构造处用 `satisfies` 约束到 wire 出站类型（见 3.2）。

### 3.2 wire：出站 schema（`ServerOutbound`）

新增 `packages/wire/src/serverOutbound.ts`，定义控制响应 schema：

| type | 载荷要点 |
|---|---|
| `auth` | `{ token, userId }` |
| `session` | `{ sessionId, projectId, workspace }` |
| `quota` | `{ ...getUserQuota 返回字段 }`（以现实现为准定字段） |
| `file-list` | `{ path, _reqId?, success?, files?, error? }`（以现 listFiles 返回为准） |
| `file-content` | `{ path, _reqId?, success?, content?, error? }` |
| `sync-manifest` / `sync-file-content` | 以 `syncHandler` 现输出为准（含 `_reqId` 回显） |
| `sessions-list` | `{ sessions: [...] }` |
| `session-deleted` / `project-workspace-deleted` | `{ ..., success, error? }` |
| `error` | `{ error }`（沿用现字段名，与 relay 错误一致） |

- `ServerOutbound = z.union([AgentEvent, ...控制响应])` 并导出 `ServerOutboundType`。
- schema 字段以**现有运行时实际输出**为准（实现时逐处核对 messageHandler/syncHandler 的 send 调用），不借机改字段——本设计只固化契约，不动协议语义。
- daemon/relay 对出站不做运行时校验（内部信道，server 构造处已类型约束）；schema 的消费者是 server 的类型检查与 App 的 `import type`。

### 3.3 App：三层拆分

**`services/serverConnection.ts`（新，无 React 依赖）**：
- 职责：连接生命周期（WS 或 RelayClient 的创建/关闭/指数退避重连）、鉴权握手（register→auth→init / relay 免 token init）、消息序列化发送、`_reqId` 请求-响应关联（file-list/read-file/sync-pull/sync-file/tool-exec 各带超时）、入站消息分发。
- 对外接口（回调风格）：
  ```ts
  interface ServerConnection {
    connect(): void; disconnect(): void;
    readonly isOpen: boolean;
    sendChat(content, opts: { model, customPrompt?, images?, rewindTo? }): void;
    abort(): void;
    execTool(toolName, args): Promise<unknown>;
    listFiles(path?): Promise<FileListResult>;
    readFile(path): Promise<FileContentResult>;
    syncPull(sinceCommit?): Promise<SyncManifestResult>;
    syncFile(commit, path): Promise<SyncFileResult>;
    on(handlers: {
      agentEvent?: (ev: AgentEventType) => void;   // 流式事件
      connected?: () => void; disconnected?: () => void;
      session?: (info) => void; authError?: (msg) => void;
      fileChanged?: (path, changeType) => void;
    }): void;
  }
  ```
- 现 useAgent 中的连接/握手/RPC/重连代码整体搬迁，逻辑不变（含 P6a 引入的 Unauthorized 停止重连）。

**`hooks/chatReducer.ts`（新，纯函数）**：
- `applyAgentEvent(messages: Message[], ev: AgentEventType): Message[]`——收拢现散布在各 `setMessages` 里的 last-assistant 更新：`text-delta` 追加 content、`reasoning-delta` 追加 thinking、`tool-call` 追加 toolCalls（按 `callId` 记录）、`tool-result` 按 `callId` 配对填 result（替代现在按 `toolName && !result` 的模糊匹配——callId 精确配对是归一化的直接收益）、`model-selected` 填 modelUsed、`error` 追加错误文案。
- `phaseFor(ev): StreamingPhase | null`——事件到 streaming phase 的推导（thinking/generating/tool-calling…）。
- App 的 `Message`/`ToolCall` 类型增加 `callId` 字段（内部结构，历史存档兼容：旧记录无 callId 不影响展示）。
- 对 `command-output`/`process-*`/`preview-available`/`usage`/`done` 返回原 messages（done 的副作用——收敛 streaming 状态/存历史/通知——留在 hook 层）。

**`hooks/useAgent.ts`（瘦身）**：
- 组合层：持有 React 状态（messages/isConnected/isStreaming/streamingPhase/currentToolName/sessionId/authError）、实例化 serverConnection 并把 `agentEvent` 接进 chatReducer、done/error 的副作用（保存历史/通知/离线队列重放）、geek loop 驱动。
- geek 适配：`streamChat` callbacks → AgentEvent（`onTextDelta→text-delta`、`onThinking→reasoning-delta`、`onToolCall→tool-call{callId:id}`、工具执行完→`tool-result{callId}`、循环结束→`done`）喂同一 reducer；`aiClient.ts` 与 geek loop 的控制流（MAX_STEPS、chatHistory 构建、本地工具执行）不动。
- **对外返回的 API 面（字段名与语义）保持不变**：`messages/isConnected/isStreaming/streamingPhase/currentToolName/sessionId/authError/needsAutoConnect/connect/disconnect/sendMessage/stopStreaming/executeTool/requestFileList/requestFileContent/requestSyncPull/requestSyncFile/...`（以现返回对象为准逐项保留），App.tsx 及各 Tab 零改动。

### 3.4 行为不变性约束

- 云端模式对话/思维链/工具调用/Diff（file-changed 本地同步）/中止/离线队列/后台通知行为与现状一致。
- 唯一有意的行为改进：tool-result 与 tool-call 的配对从"toolName + 首个无 result"改为 callId 精确配对（并发同名工具不再错配）。
- 消息持久化格式（chatHistory 的 StoredMessage）新增可选 callId 字段，向后兼容旧存档。

## 4. 测试策略

- **wire**：`ServerOutbound` 各成员正/负样例往返。
- **server**：AI-SDK part→AgentEvent 映射纯函数单测；cliRunner claude 路径现有测试更新为断言直接透传（无 bridge 字段名）；gemini 路径解析单测（合成 callId）。
- **app**：给 app 配最小 vitest（只跑 `src/**/*.test.ts` 纯 TS 模块，不碰 RN 运行时）；`chatReducer` 单测覆盖：text/reasoning 累积、callId 配对（含并发同名工具）、error 追加、未知事件类型忽略、非 assistant 尾消息时的健壮性。
- **全仓验收**：`grep -r "StreamEvent" packages/` 零命中；`cli/bridge` 不存在；`pnpm build && pnpm test:all && pnpm typecheck:app` 全绿。
- **真机回归**（用户执行）：三模式各跑一轮——cloud 直连、relay 中继、geek+local——覆盖对话、思维链、工具调用、Diff/文件同步、中止、重连。

## 5. 验收标准

1. 全仓无 `StreamEvent`、无 `cli/bridge.*`；wire 的 AgentEvent 成为 server→App 流式事件的唯一格式。
2. 出站控制响应在 wire 有 schema，messageHandler 构造处经 `satisfies` 类型约束。
3. `useAgent.ts` 显著瘦身（目标 <400 行），传输与 reducer 各自独立可测；云端与 geek 共用同一 reducer。
4. App.tsx 与各 Tab 组件零改动；`pnpm typecheck:app` 零错误。
5. 构建与全部测试绿；真机三模式回归通过。

## 6. 风险与缓解

| 风险 | 缓解 |
|---|---|
| AI SDK fullStream part 字段名随版本差异（`toolCallId`/`textDelta`） | 实现首个任务先以仓库锁定的 ai 包版本核对类型定义，映射函数以实际类型为准 |
| useAgent 搬迁遗漏隐式行为（ref 时序、AppState 通知、离线队列） | 搬迁为主、重写为辅：传输层代码块整体移动；每步跑 typecheck:app；真机回归清单兜底 |
| gemini-cli 路径无真机验证（无订阅） | 解析单测覆盖；标注"gemini 路径待真机验证"不阻塞主线 |
| 历史存档新旧 Message 结构混存 | callId 为可选字段，渲染层不依赖；不做迁移 |
