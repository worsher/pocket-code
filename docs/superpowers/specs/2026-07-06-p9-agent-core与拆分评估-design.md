# P9 agent-core（同构 agent 包）+ 项目拆分评估 设计

> 日期：2026-07-06
> 状态：已与用户确认（一期全包含：core 包 + server/App 双侧接入；拆分=评估报告+最小调整）
> 上游：重构设计 §3.5（BuiltinAgent/agent-core）、§3.6（RuntimeBackend）——三套 agent loop 收编的最后一步。
> 一句话定位：**新建同构 `@pocket-code/agent-core`（loop + 工具注册表 + ModelClient/RuntimeBackend 抽象），替换 server 的 AI-SDK 循环与 App 的 geek loop；附四个子系统的独立拆分评估与拆分预案。**

---

## 第一部分：项目拆分评估（结论存档，后续按触发条件执行）

### 总结论

**单人开发期不拆仓库**——monorepo 的迭代速度与原子提交价值远大于拆分收益。但所有包按"随时可拆"标准维护边界（依赖单向、协议经 wire、无隐式共享状态）。**触发拆分的信号**：开源某子系统、第三方项目复用、多人协作分工。

### 候选一：中继（relay）→ 独立服务/项目

- **可拆性 ★★★★**。relay 只依赖 wire；无业务逻辑（纯转发+隧道+配对）。
- **阻碍**：`RelayRequest.payload` 目前用业务 `WsMessage` 校验——独立后 relay 不该认识业务协议。
- **独立价值**：通用"设备配对 + 消息中继 + HTTP/WS 反向隧道"服务（类 ngrok），可单独部署/开源。
- **拆分预案**（触发时执行，约 1–2 天）：
  1. wire 拆层：`protocol-core`（信封 RelayRequest/Forward*、配对、隧道帧、RelayInbound/DaemonInbound）与 `app-protocol`（WsMessage/ServerOutbound/AgentEvent）；relay 只依赖前者，`payload` 校验放宽为 `z.record(z.unknown())`（业务校验本就在 daemon 的 messageHandler 兜底）。
  2. relay + protocol-core 迁出为独立 repo；版本化发布 protocol-core；daemon 侧改依赖发布版。
  3. 部署文档拆分随迁。

### 候选二：CLI 适配层（cli/*）→ 独立库

- **可拆性 ★★★★★**（P8 收编后边界最干净）。只依赖 `AgentEvent` schema + Node child_process。
- **独立价值**：最高。"以归一化事件流驱动 claude-code / codex / gemini-cli"是一个受众明确的独立 OSS（`cli-agents` 之类命名）。
- **拆分预案**（触发时执行，约 1 天）：
  1. 决定 AgentEvent 所有权：随库走（库导出 schema，wire re-export）或留 wire（库依赖 wire 发布版）。倾向前者——事件契约与产生者同包。
  2. `packages/server/src/cli/` → 新包/新 repo；server 改依赖之；E2E 守卫测试随迁。
  3. `runCliSession`（会话胶水）留在 server——它耦合 AgentSession，不属于库。

### 候选三：agent-core → 本期（P9）建包

- 按"随时可拆"标准新建：**运行时零依赖**（对 wire 只 `import type`，Metro/浏览器/Node 三端安全）；平台能力全部经 `RuntimeBackend`/`ModelClient` 注入。
- 未来拆出仓库时零改造成本。

### 候选四：多端客户端（Web 等）→ P10 最佳候选

- **可拆性 ★★★☆**。P6b 已把 App 拆成三层，其中 `serverConnection.ts` + `chatReducer.ts` + `relayClient.ts` 是平台无关 TS（浏览器原生 WebSocket 兼容，无 RN import）；仅 UI 层是 RN。
- **预案**（P10 立项时执行）：
  1. 抽 `@pocket-code/client-core` 包：serverConnection / chatReducer / relayClient / 会话与设置类型（去 AsyncStorage 等 RN 依赖，存储经接口注入）。
  2. 新建 `packages/web`（Vite + React）消费 client-core，UI 另写；RN App 改为同样消费 client-core。
  3. 端侧差异（通知/文件系统/离线队列存储）经注入接口隔离。

---

## 第二部分：P9 agent-core 设计

### 1. 背景与现状

三套 agent loop 现存两套（P8 已收编 CLI 路径）：
- server `agent.ts` AI-SDK 循环（~100 行核心 + tools.ts 699 行工具）；
- App `geekLoop.ts`（101 行循环）+ `aiClient.ts`（870 行：OpenAI/Anthropic 双 SSE 流式客户端 + `TOOL_DEFINITIONS` 第二份工具声明 + system prompt 第二份）。

重复点：loop 控制流 ×2、工具声明 ×2、system prompt ×2、事件发射 ×2。

### 2. 目标与非目标

**目标**：
1. `@pocket-code/agent-core`：多步 loop、ToolRegistry（schema+实现一份）、`ModelClient`/`RuntimeBackend` 接口；产出 P6b 归一化 AgentEvent；同构零运行时依赖。
2. server 非 CLI 路径改走 core（Node ModelClient=AI SDK 包装单步；NodeBackend=fs/child_process）；行为对 App 不变。
3. App geek 模式改走 core（RN ModelClient=aiClient SSE 包装；DeviceBackend=expo-fs 本地工具 + runCommand 经现有 WS 回退）；删除 `geekLoop.ts`。
4. CLI 委托路径（claude/codex/gemini）不动，与 core 并列。

**非目标**：aiClient 的 SSE 实现重写（只包装）；模式 C 的 WebView esbuild-wasm 预览（独立后置项）；会话历史格式迁移工具（尽力转换即可）；think/reasoning-effort 参数透传。

### 3. 核心接口

```ts
// ── 消息(OpenAI 风格,含工具往返) ──
type CoreMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | { role: "assistant"; content: string; toolCalls: { id: string; name: string; args: Record<string, unknown> }[] }
  | { role: "tool"; toolCallId: string; content: string };

// ── 模型客户端:只做"单步"——流一轮 assistant 输出,浮出 tool calls 不执行 ──
interface ModelClient {
  streamStep(req: {
    system: string;
    messages: CoreMessage[];
    tools: ToolSchema[];              // JSON-schema 声明
    signal?: AbortSignal;
  }): AsyncIterable<ModelDelta>;
}
type ModelDelta =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "usage"; inputTokens: number; outputTokens: number };

// ── 运行时后端:平台原语(重构设计 §3.6 裁剪为 MVP 所需) ──
interface RuntimeBackend {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<{ isNew: boolean }>;
  listFiles(path: string): Promise<{ name: string; type: "file" | "dir" }[]>;
  exec(cmd: string, opts?: { timeoutMs?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

// ── 工具注册表:声明+实现一份,实现只调 backend 原语 ──
interface ToolSchema { name: string; description: string; parameters: JsonSchema }
type ToolImpl = (backend: RuntimeBackend, args: Record<string, unknown>) => Promise<unknown>;

// ── 主循环 ──
function runAgentLoop(opts: {
  modelClient: ModelClient;
  backend: RuntimeBackend;
  system: string;
  history: CoreMessage[];             // 不含本轮 user 消息
  userMessage: string;
  onEvent: (ev: AgentEventType) => void;   // wire 类型,import type
  signal?: AbortSignal;
  maxSteps?: number;                  // 默认 25(对齐 server 现值)
}): Promise<{ messages: CoreMessage[]; fullText: string }>;
```

**循环语义**（两套旧 loop 的并集，以 server 版为准）：每步 `streamStep` → text/reasoning 增量即时发 `text-delta`/`reasoning-delta` → 步末若有 tool calls：逐个发 `tool-call` → 经 ToolRegistry 执行（writeFile/editFile 成功追发 `file-changed`）→ 发 `tool-result` → 结果入 messages 进入下一步；无 tool calls 或达 maxSteps 结束；`usage` 汇总后发；`done` 由**调用方**发（保持现状：server 的 messageHandler 语义、App 的 hook 层收敛）。abort：signal 透传 ModelClient + 循环步间检查。

### 4. 工具集（core 内一份）

以 server `tools.ts` 现有集合为准迁移（readFile/writeFile/editFile/listFiles/runCommand/git 九件套/search 等），实现改写为调 backend 原语；`safePath` 防穿越逻辑随迁 core（纯函数）。App 侧 `TOOL_DEFINITIONS`（aiClient 内）删除，geek 模式工具能力自动对齐 server（净增强：geek 从 4 个工具变全集）。system prompt 同样收敛 core 一份（以 server 版为基，App 版差异合并）。

### 5. 两侧接入

**server（阶段二）**：
- `NodeModelClient(modelKey)`：包 AI SDK `streamText`（tools 声明传入但**无 execute** → 单步浮出 toolCalls；`maxSteps:1`）；provider 复用现 `getModel`。
- `NodeBackend(workspace, containerId)`：fs/child_process/docker-exec（现 tools.ts 的执行细节下沉此处）。
- `agent.ts`：非 CLI 分支改为组装 client+backend 调 `runAgentLoop`；会话历史 CoreMessage 直接 JSON 持久化；**老会话 AI-SDK 格式历史尽力转换**（role/content 字符串保留，工具往返细节丢弃并记日志）。
- `tools.ts` 大部分逻辑迁 core 后删除或缩为 NodeBackend。

**App（阶段三）**：
- `RnModelClient(modelConfig, apiKey, settings)`：包 `aiClient.streamChatOpenAI/Anthropic`（callbacks → AsyncIterable 适配）。
- `DeviceBackend`：readFile/writeFile/listFiles → 现 `localFileSystem`；exec → 现 executeTool 语义（local 优先、`conn.execTool` WS 回退）。
- `useAgent.sendGeekMessage`：`runGeekLoop` 调用替换为 `runAgentLoop`（onEvent 直接喂现有 reducer——事件契约不变，UI 零改动）；**删除 `geekLoop.ts`**；`aiClient.ts` 的 TOOL_DEFINITIONS/buildSystemPrompt/chatHistory 构建移除，只留 SSE 流式客户端。
- Metro 集成：agent-core 以 workspace 依赖进 app（同 P6b 的 wire type-only 先例，但 core 是**运行时**依赖——core 零第三方依赖、纯 TS，Metro 直接可编）。

### 6. 测试策略

- **core**（大头，纯函数环境）：fake ModelClient（脚本化 delta 序列）+ fake Backend——多步循环/工具执行顺序/事件序列（含 file-changed 派生、callId 贯穿）/abort 中断/maxSteps 截断/错误路径；工具实现逐个对 fake backend 单测；safePath 迁移带原测试。
- **server**：NodeBackend 对真实临时目录单测（fs/exec/git）；NodeModelClient 对 AI SDK 的单步适配（mock streamText）；agent.ts 接入后现有 server 测试全过；老历史转换单测。
- **app**：RnModelClient 的 callbacks→AsyncIterable 适配纯函数单测；DeviceBackend 类型对齐（typecheck 门禁）；chatReducer 既有测试不回归。
- **真机**：三模式回归 + geek 模式工具全集验证（新能力：geek 下 git/search 可用）。

### 7. 验收标准

1. `pnpm build && pnpm test:all && pnpm typecheck:app` 全绿；`geekLoop.ts` 不存在；工具声明/system prompt 全仓各一份（core 内）。
2. server 侧 API 模型对话行为不变（真机回归）；CLI 路径零变化。
3. App geek 模式经 core 跑通（真机），工具能力升级为全集。
4. agent-core 包运行时零第三方依赖（`package.json` dependencies 为空或仅 type-only）。

### 8. 风险与缓解

| 风险 | 缓解 |
|---|---|
| AI SDK "无 execute 工具"的单步行为与假设不符 | 阶段二首任务先做 spike 单测锁定行为；不行则 NodeModelClient 直接走 provider SDK 原始接口（工作量+1 天） |
| aiClient callbacks→AsyncIterable 适配的背压/时序 | 用简单队列缓冲适配器 + 单测覆盖乱序/中断 |
| 老会话历史转换丢工具细节 | 明示为已知取舍（文本上下文保留，重要历史可重新开会话） |
| geek 工具全集在 RN 环境的边界（git 经 exec 回退 WS） | DeviceBackend.exec 全部走现有 executeTool 回退链路，不新增端侧执行面 |
| 计划体量大（10–12 任务） | 三阶段各自独立可验收，阶段间可暂停 |
