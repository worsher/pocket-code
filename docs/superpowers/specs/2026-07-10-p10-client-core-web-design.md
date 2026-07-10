# P10 client-core（平台无关客户端核心包）+ Web 端 设计

> 日期：2026-07-10
> 状态：已与用户确认（范围 Chat+Files+Diff；可拆边界级；Web 先行、RN 下期切；双连接拓扑；方案 A 正典迁移+冻结副本）
>
> 一句话定位：**把 App 中已平台无关的三个模块（serverConnection / chatReducer / relayClient）抽为 `@pocket-code/client-core` 包（正典），新建 `packages/web`（Vite + React）作为第二个消费者，验证包边界；RN App 本期不切换（副本冻结，P11 切换后删除）。**

## 0. 决策记录

| 决策点 | 结论 | 理由 |
|---|---|---|
| Web MVP 范围 | Chat + Files + Diff | 覆盖"对话+看代码改动"场景；Terminal/Preview 后置 |
| 开源标准 | 可拆边界级 | 零平台依赖、能力接口注入、独立测试、依赖单向；发布件（README/LICENSE/npm）触发开源时再补 |
| RN 切换时机 | Web 先行，RN 下期（P11）切 | 真机验收刚完成，本期零回归风险；以冻结副本控分叉 |
| 连接拓扑 | LAN 直连 + relay 中继都支持 | serverConnection 已抽象好两条路径，完整验证 client-core |
| 抽取策略 | 方案 A：正典迁移 + 冻结副本 | 搬运不重写（代码刚经真机验收）；client-core 为唯一演进点 |

## 1. 背景与现状

P6b 已把 App 拆成三层：useAgent（RN 组合层）← chatReducer（纯函数）← ServerConnection（传输层）。其中三个模块已是平台无关 TS：

- `serverConnection.ts`：WS/Relay 生命周期、指数退避重连、鉴权握手、`_reqId` RPC（list-files/read-file 等）、消息分发。依赖注入型（`ConnectionConfig`/`ConnectionHandlers`），仅依赖 relayClient 与 wire 类型。
- `relayClient.ts`：Relay 信封协议包装（连接归一化、配对、机器发现、请求转发）。**唯一 RN 运行时耦合**：配对成功后调 `updateSettings`（AsyncStorage）持久化 token。
- `chatReducer.ts`：AgentEvent → 消息列表的纯函数 reducer。两个 type-only 导入来自 App 内部（`StreamingPhase` 来自组件、`StoredMessage` 来自 store）。

App 的原生部分（pocket-terminal-module，Kotlin+C++/JNI）只被 TerminalScreen 和 runtimeManager 消费，与本期三模块零交集。

Diff 不是独立协议：App 的 DiffPreview 从聊天流工具事件（write/edit 的新旧内容）渲染。Files 走 serverConnection 已封装的 `list-files`/`read-file` RPC。**因此 Chat+Files+Diff 范围内，三模块已覆盖全部协议能力，Web 端剩余为纯 UI 工作。**

## 2. client-core 包设计

### 2.1 结构（与 agent-core 同模板：tsc 构建 + vitest + TS strict）

```
packages/client-core/
  src/
    serverConnection.ts   ← 迁入，零改动
    relayClient.ts        ← 迁入，去 RN 化（见 2.2）
    chatReducer.ts        ← 迁入，类型收编（见 2.3）
    types.ts              ← Message/ImageAttachment/StoredMessage/StreamingPhase 等会话与设置类型
    index.ts              ← 显式导出面（不 export *）
    chatReducer.test.ts   ← 随迁
    relayClient.test.ts   ← 随迁
    serverConnection.test.ts ← 本期新增（握手/RPC 超时/重连退避核心路径）
```

### 2.2 去 RN 化（仅一处）

`RelayClientOptions` 增加注入回调：

```ts
/** 配对成功后由宿主持久化 token（RN: updateSettings；Web: localStorage） */
onTokenPersist?: (token: string, machineId: string) => void;
```

`updateToken()` 内部改调该回调，删除 `import { updateSettings } from "../store/settings"`。

### 2.3 类型收编

`StreamingPhase`（现从 `components/StreamingIndicator` 导入）与 `StoredMessage`（现从 `store/chatHistory` 导入）移入包内 `types.ts`。App 侧原位置改为从 client-core re-export——这是 App 侧唯一允许的改动（类型来源反转），不算破冻结。

### 2.4 依赖边界

- dependencies：仅 `@pocket-code/wire`、`@pocket-code/agent-core`（workspace），且全部 type-only 导入 → **运行时零依赖**。
- 依赖方向单向：`client-core → wire/agent-core`；不依赖 app/server/relay/daemon，不被 wire/agent-core 反向依赖。
- 无隐式共享状态；端侧能力（存储）一律接口注入。

## 3. Web 端设计（packages/web）

技术栈：Vite + React 19 + TS strict + vitest。不引 UI 组件库，手写轻量 CSS，深色主题对齐 App。

### 3.1 界面

- **连接/配对页**：两种方式——LAN 直连（输入 `ws://开发机IP:端口`）或 relay（relay 地址 + 配对码，走 `relayClient.pairDevice`）。连接配置与 token 存 localStorage（实现注入接口，对应 RN 侧 AsyncStorage）。
- **Chat 页**：新写轻量 `useWebAgent` 组合 hook——对应 App useAgent 但砍掉 RN 专属（AppState/通知/离线队列/geek 模式），复用 client-core 的 `ServerConnection` + `chatReducer`。流式渲染、工具事件卡片。
- **Diff**：内联在 Chat 工具事件卡片中渲染（逻辑对齐 App DiffPreview，UI 重写 web 版），不做独立页面。
- **Files 页**：文件树 + 文件内容查看，直接消费 `list-files`/`read-file` RPC。

### 3.2 数据流与错误处理

与 App 完全同构：`ServerConnection` 负责重连退避/握手/RPC 超时；UI 挂 `onConnected/onDisconnected/onAuthError` 显示连接状态条。

已知限制（写入 web README/文档即可，不做代码规避）：部署为 https 页面时，浏览器 mixed-content 策略会阻断 LAN 直连 `ws://`；本地 http 开发页无此问题；relay 路径走 `wss://` 不受影响。

## 4. 测试与验收

- client-core：迁入测试全绿；新增 serverConnection 核心路径测试（握手、RPC 超时、重连退避）。
- web：`useWebAgent` 冒烟测试（假 WebSocket 驱动 AgentEvent 流，断言 reducer 产出）。
- 人工验收：LAN 直连与 relay 两条路径，各跑通 Chat（含 Diff 渲染）+ Files。
- 全仓门禁不回归：`pnpm build`、`pnpm test:all`、`pnpm typecheck:app` 全绿（test:all 与 CI 纳入 client-core 与 web）。

## 5. 分叉控制（冻结副本）

- App 侧 `services/serverConnection.ts`、`services/relayClient.ts`、`hooks/chatReducer.ts` 加头注释：
  > 已被 @pocket-code/client-core 收编为正典。此副本冻结：只修 bug 且必须双侧同步；P11 RN 切换时删除。
- App 侧对应测试文件同样冻结（relayClient.test.ts、chatReducer.test.ts）。
- plan.md 待办追加 **P11：RN App 切换消费 client-core，删除冻结副本**（分叉窗口的明确退出点）。

## 6. 非目标

- RN App 切换到 client-core（P11）。
- 开源发布件：README/LICENSE/独立版本号/npm publish/API 文档（触发开源时再补）。
- geek 模式 Web 化（DeviceBackend 依赖 RN 文件系统，Web 无对应）。
- Terminal / Preview 界面。
- 会话跨端同步（Web 与 App 各自本地存储会话）。
- aiClient/SSE 直连模型（Web 只走 daemon/relay 路径）。

## 7. 与拆分路线的关系

本包按"随时可拆"标准建立，即 plan.md 拆分路线中 client-core 候选的落地。触发开源时，剩余工作仅为发布件补齐（见非目标），无需再动包边界。
