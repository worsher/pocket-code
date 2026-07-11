# CLI 适配层拆库(@pocket-code/cli-agent)· 设计

日期:2026-07-11
状态:已评审(逐节确认通过)
前置:P3(CliAgentAdapter + runner)、P8(codex/gemini 适配器)、2026-07-11 CLI 执行层缺陷修复(后台进程/resume/超时/门控,已合 master)
关系:plan.md 拆分路线第 2 项("独立 OSS 库,约 1 天,价值最高");本轮为**拆**,发布(git subtree + npm)按既定策略后置。

## 1. 背景与目标

驱动 claude-code/codex/gemini CLI 的归一化事件流适配层现位于 `packages/server/src/cli/`,与 server 有三处耦合:

| # | 耦合 | 位置 |
|---|---|---|
| 1 | 所有 cli 文件依赖 `@pocket-code/wire` 的 `AgentEventType`(13 变体私有 zod union;cli 产其中 **8** 个 —— 执行期修正:设计时漏读 codex 的 `file-changed`) | types/runner/三适配器 |
| 2 | runner 依赖 `../processKill.js`(server/src 下的 killProcessTree) | runner.ts |
| 3 | `runCliSession` 直接读写 `AgentSession`(messages/cliSessions/workspace/customPrompt) | index.ts |

**目标**:抽成 monorepo 内独立包 `packages/cli-agent/`(`@pocket-code/cli-agent`),**零运行时依赖、自有事件类型、发布就绪**,达到与 relay/agent-core/client-core 同级的"随时可 git subtree 抽出"终态。真发 npm/独立 repo 按既定策略等触发信号(开源/第三方复用/多人协作)。

## 2. 决策记录

| # | 决策点 | 结论 |
|---|---|---|
| D1 | 事件类型归属 | **库自定义 `CliEvent`**(**8** 变体纯 TS 判别联合,无 zod;设计时写 7,执行期发现 codex 还产 `file-changed`,已补);字段名与 wire 对应变体对齐(file-changed 取 codex 实际产出的窄形态 `{path, changeType}`,窄于 wire 的可选 oldContent/newContent 但结构可赋值)→ server 侧映射为编译期验证的恒等函数 |
| D2 | 包边界 | **库只拿 runner+adapters+编排**(纯函数 `runCliAgent`);session 读写(runCliSession/injectHistory)留 server 薄包装 —— 库完全不认识 AgentSession |
| D3 | processKill 归属 | **进库**(runner 自足);server 的 processRegistry 改从库 import,删 `server/src/processKill.ts`(单一真相源) |
| D4 | 拆库程度 | **monorepo 内独立包达"随时可迁"**,不真发 npm、不建独立 repo(对齐单人期既定策略) |

## 3. CliEvent 类型与恒等映射(D1 核心)

库自有类型(`packages/cli-agent/src/types.ts`):

```ts
export type CliEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call"; callId: string; name: string; args: Record<string, unknown> }
  | { type: "tool-result"; callId: string; result: unknown; isError?: boolean }
  | { type: "file-changed"; path: string; changeType: "created" | "modified" | "deleted" } // 执行期补充:codex 产出;窄于 wire(无 oldContent?/newContent?)但结构可赋值
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "done" }
  | { type: "error"; message: string; code?: string };
```

**映射层**(server 侧):因字段逐字对齐,每个 CliEvent 变体结构兼容 wire `AgentEventType` 对应变体:

```ts
/** 零运行时成本;wire 若改字段此处 tsc 立即报错(漂移哨兵)。 */
const toAgentEvent = (e: CliEvent): AgentEventType => e;
```

不写 switch 分支 —— 恒等 + 类型检查即映射;漂移在编译期暴露,不会静默丢字段。

`CliAgentAdapter`/`CliSpawnContext`/`CliSpawnSpec` 随迁进库,接口中 `AgentEventType` 全部替换为 `CliEvent`,其余逐字不变(含 supportsResume/extractSessionId/parseLine/createParser 契约)。

## 4. 迁移布局

**进库 `packages/cli-agent/src/`**:

| 文件 | 动作 |
|---|---|
| `types.ts` | 新写(CliEvent + 三接口,AgentEventType→CliEvent) |
| `processKill.ts` + `.test.ts` | 从 server/src 迁入(server 侧删除) |
| `runner.ts` + `.test.ts` | 迁入;import 改库内(`./types.js`/`./processKill.js`);逻辑零变化 |
| `claudeCode.ts`/`codex.ts`/`gemini.ts` + 各 `.test.ts` | 迁入;import 换库 types;解析逻辑零变化 |
| `claudeCode.e2e.test.ts`/`codex.e2e.test.ts`/`gemini.e2e.test.ts` | 迁入(驱动真实 CLI,属库的验收面) |
| `index.ts` | 库入口:导出 `cliAdapters` 注册表 + `runCliAgent` + `killProcessTree`/`isProcessAlive` + 全类型 |
| `package.json`/`README.md`/`tsconfig.json`/vitest 配置 | 发布就绪件(对齐 relay/protocol-core 标准:name/version/type:module/exports/files 齐;README 含三适配器说明/契约/用法示例/已知限制如 claude env 清理) |

**留 server `packages/server/src/cli/`**(目录保留,瘦身到 3 文件):

- `index.ts` **重写为薄包装**:`runCliSession` + `injectHistory` + `toAgentEvent` 恒等映射 + re-export `cliAdapters` 及所需类型 —— **agent.ts/messageHandler 的 import 路径 `./cli/index.js` 不变,消费端零 churn**。
- `index.test.ts`(runCliSession 的 injectHistory/resume 测试)留。
- `session.test.ts` 留。
- **删除**:`types.ts`/`runner.ts`/三适配器及其全部单测与 e2e(已迁库)。

**server 其他改动**:

- `processRegistry.ts`:`import { killProcessTree } from "./processKill.js"` → `from "@pocket-code/cli-agent"`;删 `server/src/processKill.ts` + `.test.ts`。
- server `package.json` 加 `"@pocket-code/cli-agent": "workspace:*"`。

## 5. 数据流(拆后)

```
messageHandler/agent.ts
  → runCliSession(server 薄包装: 读 session → injectHistory(codex/gemini)/resumeSessionId(claude))
    → runCliAgent(库: buildSpawn → spawn CLI → 逐行 parseLine → CliEvent 流 + extractSessionId 采集)
    ← onEvent(toAgentEvent(cliEvent))  // 恒等映射后上抛 wire 事件
  ← { fullText, cliSessionId }
  → 写回 session.messages / session.cliSessions
```

## 6. 测试策略

- 迁移测试**逐字随迁**(runner 13 例、三适配器全部单测、processKill 3 例、e2e 3 件)—— 在库包内跑,断言零改动(仅 import 路径换)。
- server 侧留 index.test.ts(runCliSession)/session.test.ts,断言零改动。
- **新增仅两处**:① 恒等映射的编译期锚(一个把全部 7 个 CliEvent 变体逐个传入 `toAgentEvent` 的类型测试/tsc 即门);② 库入口导出面 smoke(cliAdapters 含三 id、runCliAgent/killProcessTree 可导入)。
- 隔离验证:grep 断言库内**零** `@pocket-code/wire`、零 `AgentSession`、零 `../` 越包引用;库 `package.json` dependencies 为空。

## 7. 验收标准

- `pnpm test:all` 全绿(新包自动纳入);`pnpm --filter @pocket-code/cli-agent test` 独立绿。
- 两包 tsc 0 错误(cli-agent、server;daemon 不受影响顺带确认)。
- grep 隔离断言通过(§6);server/src/cli/ 恰 3 文件;server/src/processKill.ts 不存在。
- 库 package.json 发布就绪(name/exports/files);README 齐。
- 行为零变化:CLI 委托全链(claude resume/codex-gemini 历史注入/空闲超时/stderr 尾)语义与拆前逐字等价。

## 8. 执行顺序

1. 建包骨架(package.json/tsconfig/vitest)+ types.ts(CliEvent + 三接口)。
2. processKill 迁入 + processRegistry 改 import + 删 server 侧原件。
3. runner 迁入(import 换)+ 测试随迁。
4. 三适配器迁入 + 测试/e2e 随迁。
5. 库 index.ts 入口 + 导出面 smoke。
6. server/src/cli/index.ts 重写为薄包装(runCliSession + injectHistory + toAgentEvent + re-export)+ 删已迁文件。
7. README + plan.md 拆分路线状态更新 + 全量验证。

依据:自底向上(types→util→runner→adapters→入口→server 接线),每步全绿可停。

## 9. 风险与回滚

- 迁移为搬文件+改 import,逻辑零变化;唯一新逻辑是恒等映射(编译期验证,漂移即 tsc 报错)。
- e2e 测试(真实 CLI)在库内继续 skip-by-default(现状),不阻塞 CI。
- 回滚:单分支未合并直接弃。

## 10. 范围外

真发 npm / git subtree 独立 repo(等触发信号)、cliSessions 持久化(既有 backlog)、新适配器(如 aider)、CliEvent 增变体、server 之外消费方(App 不直用 cli 层)。
