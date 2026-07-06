# P8 codex / gemini-cli 适配器 设计

> 日期：2026-07-06
> 状态：已与用户确认（方案 A：两个适配器 + 注册表统一入口 + 删 cliRunner）
> 上游：重构设计 §3.4（CliAgentAdapter："每个工具一个适配器，消除重复"）；P3 只落地了 claude-code，本设计补齐 codex 与 gemini-cli 并清掉 cliRunner 遗留。
> 一句话定位：**codex、gemini-cli 接入 CliAgentAdapter 架构，agent 路由改注册表查找，删除 cliRunner.ts 技术债。**

---

## 1. 背景与现状

- `cli/` 架构（P3）：`CliAgentAdapter { id, buildSpawn, parseLine, supportsResume }` + 通用 `runCliAgent` 运行器（spawn/行缓冲/killTree/done-error 语义）。目前注册表只有 claude-code。
- `cliRunner.ts`（222 行）遗留：`runClaudeCodeAgent`（已是 adapter 的薄包装）+ `runGeminiCliAgent`（自带 spawn 循环）+ `createGeminiLineParser`（P6b 已归一化产出 AgentEvent）。
- `agent.ts:160-171`：`claude-code` / `gemini-cli` 两个 if 硬编码路由。
- App `modelConfig.ts` 已有 claude-code、gemini-cli 入口，无 codex。
- **实测依据（2026-07-06，本机 codex-cli 0.45.0 / gemini 0.27.3）**：
  - codex `exec --json` 输出 JSONL：`thread.started{thread_id}`、`turn.started`、`error{message}`、`turn.failed{error:{message}}` 已实测；`item.started/updated/completed`（item 类型 `agent_message/reasoning/command_execution/file_change/mcp_tool_call/todo_list` 等）与 `turn.completed{usage:{input_tokens,cached_input_tokens,output_tokens}}` 为 codex 0.4x 已知格式，实现时以 fixture 单测锁定。
  - codex 非信任目录直接拒绝运行 → spawn 必须带 `--skip-git-repo-check`。
  - 用户 codex 走 `config.toml` 配置的第三方镜像（api5.ai）→ **不清 OPENAI_*/CODEX_* env**（与 claude 适配器"清 ANTHROPIC_*"策略相反且有意：claude 用 OAuth 需防劫持，codex 的镜像配置是用户主动为之）。
  - gemini `--output-format stream-json` 的 `init/message/result` 形态与现解析器完全吻合（实测确认）。

## 2. 目标与非目标

### 2.1 目标

1. `codexAdapter`、`geminiAdapter` 进 `cli/` 注册表；App 可选 Codex（gemini/claude 入口已存在）。
2. `agent.ts` CLI 路由改为注册表查找 + 通用 session 包装——新增 CLI 只需注册适配器。
3. **删除 `cliRunner.ts`**；gemini 的 spawn 参数/env 清理/解析逻辑等价迁移。
4. claude-code 路径行为零变化（纯路由重构）。

### 2.2 非目标

- codex 会话续接（`supportsResume` 均为 false，与 claude 一致，YAGNI）。
- codex 沙箱细分模式（用 `--dangerously-bypass-approvals-and-sandbox`，与 claude 路径 `--dangerously-skip-permissions` 同级信任——个人工具，agent 需要跑 npm/dev server；SaaS 化时随整体沙箱策略重新评估）。
- App 端 UI 变化（只加一个模型条目，渲染层零改动）。
- codex 的 MCP 工具/todo_list 等事件的精细渲染——映射为通用 tool-call/tool-result，UI 现有卡片直接可用。

## 3. 设计

### 3.1 `cli/codex.ts`

```ts
buildSpawn(userMessage, ctx) => {
  cmd: process.env.CODEX_CLI_PATH || "codex",
  args: [
    "exec", "--json",
    "--skip-git-repo-check",                    // workspace 可能不是 git 仓库/不在信任列表
    "--dangerously-bypass-approvals-and-sandbox",
    ...(ctx.customPrompt?.trim() ? [] : []),    // codex 无 append-system-prompt 等价物:
    userMessage,                                 // customPrompt 前置拼进 userMessage(见下)
  ],
  env: { ...process.env },                       // 不清理:尊重用户 config.toml(镜像/模型)
  cwd: ctx.workspace,
}
```

- customPrompt 处理：codex exec 无系统提示词参数，`ctx.customPrompt` 非空时拼为 `"## Project Instructions\n<customPrompt>\n\n<userMessage>"` 前缀（一次性指令，语义近似）。
- `parseLine`（NDJSON 一行 → `AgentEvent[]`）：

| codex 事件 | AgentEvent |
|---|---|
| `thread.started` / `turn.started` | 无（日志级忽略） |
| `item.completed` item.type=`agent_message` | `text-delta {text: item.text}` |
| `item.completed` item.type=`reasoning` | `reasoning-delta {text: item.text}`（空文本跳过） |
| `item.started` item.type=`command_execution` | `tool-call {callId: item.id, name: "runCommand", args: {command: item.command}}` |
| `item.completed` item.type=`command_execution` | `tool-result {callId: item.id, result: {output: item.aggregated_output, exitCode: item.exit_code}, isError: exit_code!==0}` |
| `item.completed` item.type=`file_change` | 对 `item.changes[]` 逐个发 `file-changed {path, changeType: add→created/update→modified/delete→deleted}` |
| `item.started/completed` item.type=`mcp_tool_call` | `tool-call/tool-result`（name 取 `item.server + "." + item.tool`，result 取 item 整体） |
| `item.*` 其他类型（todo_list、web_search 等） | 忽略（无 UI 消费者） |
| `turn.completed` | `usage {inputTokens: usage.input_tokens, outputTokens: usage.output_tokens}` |
| `error` | `error {message}` |
| `turn.failed` | `error {message: error.message}` |

- item.updated 的增量（若出现）忽略——与 claude 适配器"按完整消息出 text"的既有取舍一致；`done` 由 runner 在进程结束时统一发。
- 字段名以实现时的 fixture 为准（fixture 来自真机 `codex exec --json` 的一次成功会话；若镜像不可用则以 codex-rs 源码 JSONL schema 为准并在 E2E 里守卫）。

### 3.2 `cli/gemini.ts`

- `buildSpawn` 等价迁移 `runGeminiCliAgent`（`--prompt/--output-format stream-json/--yolo/--extensions` 处理、`GEMINI_CLI_MODEL`、清 `GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT`、`GEMINI_CLI_PATH`）；customPrompt 同 codex 策略（gemini exec 亦无系统提示词参数）——**这是与旧路径唯一的有意差异**（旧路径直接丢弃 customPrompt）。
- `parseLine` 等价迁移 `createGeminiLineParser`（含 tool_id→callId、合成 `gm_N`、isError、result/error 行映射），改造成无状态工厂→适配器实例方法（计数器挂闭包，`createParser()` 模式与接口对齐，见 3.4）。

### 3.3 `agent.ts` 路由重构

两个 if 硬编码替换为：

```ts
const adapter = cliAdapters[session.modelKey];
if (adapter) {
  session.messages.push({ role: "user", content: userMessage });
  await runCliSession(adapter, session, userMessage, onEvent, signal);
  saveSession(...);
  return;
}
```

`runCliSession`（新，放 `cli/index.ts`）：原 `runClaudeCodeAgent` 的通用化——调 `runCliAgent`，结束后 `session.messages.push({role:"assistant", content: fullText || "(<id> completed)"})`。

### 3.4 接口适配（parseLine 有状态问题）

现 `CliAgentAdapter.parseLine` 是单函数；gemini/codex 都需要每次运行独立的解析状态（gemini 合成计数、codex 无状态但保留一致性）。**接口演进**：`parseLine` 改为可选，新增可选 `createParser(): (line) => AgentEvent[]`——runner 优先用 `createParser()`（每次运行新建），否则退回 `parseLine`。claude 适配器不动（无状态 parseLine 继续用）。

### 3.5 App 与 server 模型表

- `modelConfig.ts` 加 `{ key: "codex", label: "Codex", description: "OpenAI Codex CLI(开发机订阅)", modelId: "codex", provider: "cli" }`（字段以现 gemini-cli 条目为准对齐）。
- `agent.ts` 的 `MODELS` 表加 `"codex": { provider: "cli-codex", modelId: "codex" }`（保持表完整性，路由实际走注册表）。

### 3.6 删除清单

- `cliRunner.ts` 整文件（`runClaudeCodeAgent`/`runGeminiCliAgent`/`createGeminiLineParser`/`GeminiStreamLine`）。
- `cliRunner.gemini.test.ts` 迁移为 `cli/gemini.test.ts`（断言目标从工厂函数改为适配器）。
- `agent.ts` 对 cliRunner 的 import。

## 4. 测试策略

- `cli/codex.test.ts`：parseLine 全表 fixture 单测（3.1 表格逐行 + 非 JSON 行忽略 + 全事件过 `AgentEvent.safeParse`）；buildSpawn 参数断言（含 `--skip-git-repo-check`、customPrompt 拼接、env 不清理）。
- `cli/gemini.test.ts`：迁移现有 5 个用例 + buildSpawn 断言（args/env 清理/GEMINI_CLI_MODEL）。
- `cli/index`：注册表含三个 id；`runCliSession` 用可注入 spawn 的 fake 进程测 push assistant 语义（复用 runner.test 模式）。
- 真机 E2E（`RUN_CLI_E2E=1` 守卫，CI 跳过）：codex、gemini 各一条最小 prompt 全链路（依赖用户镜像/网络可用，失败不阻塞合并）。
- claude 回归：现有 claudeCode 测试 + `RUN_CLI_E2E` claude E2E 不动。

## 5. 验收标准

1. `pnpm build && pnpm test:all && pnpm typecheck:app` 全绿；`cliRunner.ts` 不存在；`grep -r "cliRunner" packages/` 零命中。
2. 手机选 Codex / Gemini 发消息 → 流式回复 + 工具调用卡片正常（真机，依赖镜像可用性）。
3. claude-code 路径真机回归无变化。

## 6. 风险与缓解

| 风险 | 缓解 |
|---|---|
| codex JSONL 字段名与假设有出入（0.4x 版本差异） | 实现首任务先真机抓一次成功会话做 fixture；抓不到（镜像故障）则以 codex-rs 源码 schema 为准 + E2E 守卫兜底 |
| codex 镜像(api5.ai)不可用导致 E2E 无法验证 | E2E 有 RUN_CLI_E2E 守卫本就不进 CI；真机验收标注"依赖镜像可用" |
| gemini 迁移引入行为漂移 | 解析测试原样迁移 + spawn 参数逐项断言；唯一有意差异（customPrompt 拼接）在 spec 明示 |
