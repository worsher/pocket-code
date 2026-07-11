# CLI/执行层缺陷修复 · 设计

日期:2026-07-11
状态:已评审(逐节确认通过)
前置:P3(CliAgentAdapter + runner)、P8(codex/gemini 适配器 + 注册表)、P9(agent-core 零依赖 RuntimeBackend)
关系:本轮为 **cli 适配层拆库(plan.md 拆分路线第 2 项)的前置** —— 先修 cli/执行层功能债,拆库作为紧接的下一轮 spec。

## 1. 背景与目标

用户点名的问题:**后台能力缺失** —— agent 起 dev server 后进程立即断。审计定位:`nodeBackend`(server 侧 RuntimeBackend 实现)**只实现了 exec,没实现 `startProcess`/`stopProcess`**(契约 `agent-core/src/types.ts:40-41` 中二者为可选)。因此:
- `execTools.ts:438` 的能力门控 `if (!backend.startProcess || !backend.stopProcess) return []` → server 侧 **runInBackground/stopProcess 工具根本没注册**;
- 但 `prompt.ts:17,27-28` 却**明确告诉模型有 runInBackground**并要求用它起 dev server —— prompt 承诺了后端不存在的能力;
- 模型退而用 `runCommand` 起 dev server → `nodeBackend.exec` 用 `execAsync`(一次性,默认 30s 超时)→ 进程被杀/超时断。

审计连带发现的同类"承诺 vs 现实"错配,一并修:

| # | 缺陷 | 现状 |
|---|---|---|
| 1 | server 侧无后台进程能力 | nodeBackend 缺 startProcess/stopProcess |
| 2 | CLI 委托路径无跨轮记忆 | runCliSession 每轮全新进程,claude 的 session_id 未捕获,codex/gemini 无历史 |
| 4 | runner 无空闲超时 | CLI 卡死(等输入/挂起)时永久悬挂 |
| 5 | stderr 仅 console.warn | CLI 失败时错误上下文不进 error 事件,端侧无痕 |
| 7 | runCommand 固定 30s 超时 | npm install 等合法长命令被杀,且模型不能调 |
| 8 | 无后台进程注册/清理 | (随 #1)进程归属、堆积、退出清理未定义 |
| 9 | prompt 无能力门控 | 后端无 startProcess 时仍宣传 runInBackground |

**目标**:修 #1/#2/#4/#5/#7/#8/#9,使执行层"承诺=现实";为拆库扫清 cli 层功能债。

**范围外(记录)**:#3 CLI 自身起的后台服务生命周期(claude 的 bash 子进程归 claude 管,不可控);#6 codex/gemini env 劫持清理(无实证);拆库本身(下一轮)。

## 2. 决策记录

| # | 决策点 | 结论 |
|---|---|---|
| D1 | scope 组合 | 先修缺陷(本轮)→ 复查同类问题 → 拆库(下一轮独立 spec) |
| D2 | 后台进程归属 | **daemon 级常驻**:进程注册表挂全局按 workspace 分组;session TTL 不杀进程;dev server 活到显式 stopProcess 或 daemon 退出 |
| D3 | 进程堆积防护 | 同 workspace + 同 command 再起时,先杀旧再起新 |
| D4 | CLI 跨轮记忆 | **claude 用 --resume**(捕获 stream-json 首条 init 的 session_id);**codex/gemini 注入近 6 轮历史摘要**(各截 500 字符) |
| D5 | runCommand 超时 | 默认 30s→120s;schema 加可选 `timeoutSeconds`(clamp 1..600) |
| D6 | 全局 vs 空闲超时 | runner 只设**空闲**超时(120s 无输出);长任务合法,不设全局上限 |
| D7 | stderr | 环形缓冲 2KB 尾部;仅进程判定失败时附进 error;成功维持丢弃 |

## 3. 组件与改动

### A. 后台进程能力(#1 #8)

**新模块 `packages/server/src/processRegistry.ts`**(daemon 级单例):

```ts
interface ManagedProcess {
  processId: string;   // p_<hex>
  workspace: string;
  command: string;
  pid: number;
  containerId?: string;
  startedAt: number;
}
startManaged(workspace: string, command: string, opts?: { containerId?: string }): Promise<{ processId: string }>
stopManaged(processId: string): Promise<void>   // killProcessTree 语义
listManaged(workspace?: string): ManagedProcess[]
shutdownAll(): void                              // 挂 process SIGTERM/SIGINT/exit
```

- host 分支:`spawn(command, { shell: true, detached: true, stdio: "ignore" })`;v1 不捕获输出(端口从命令已知,prompt 教模型播报)。
- docker 分支(`isDockerEnabled()`):`docker exec -d <containerId> sh -c <command>` 起;registry 记 containerId;`stopManaged` 对 docker 进程用容器内 `pkill -f <command>`(`docker exec -d` 拿不到宿主可见 pid,这是 docker 分支的既定简化)。
- 进程自然退出(host `proc.on("close")`)自动摘除注册表。
- 同 workspace + 同 command 再起 → 先 `stopManaged` 旧的(D3)。
- `killProcessTree` 从 `cli/runner.ts` 提为共享模块 `packages/server/src/processKill.ts`,registry 与 runner 共用。

**nodeBackend 接线**:`startProcess(cmd, opts)` → `resolveHostCwd(workspace, opts?.cwd)` 后转 `startManaged`;`stopProcess(id)` → `stopManaged`。契约签名(`types.ts:40-41`)不变。

**入口挂清理**:server/daemon 入口 `process.on("SIGTERM"|"SIGINT"|"exit", shutdownAll)`;`shutdownAll` 幂等(pm2 下双信号都可能到)。

### B. runCommand 超时(#7)

`execTools.ts` runCommandSchema 加:

```ts
timeoutSeconds: { type: "number", description: "Command timeout in seconds (default 120, max 600)." }
```

execute:`timeoutMs: Math.min(Math.max(Math.floor(Number(args.timeoutSeconds) || 120), 1), 600) * 1000`。

### C. prompt 能力门控(#9)

`buildSystemPrompt(customPrompt?, opts?: { supportsBackground?: boolean })`:
- `supportsBackground` 为真才输出 Shell 段的 runInBackground 行(现 prompt.ts:17 Shell 行、27-28 两条 guideline)。
- 为假时:Shell 段只列 runCommand,且不出现 runInBackground/stopProcess 字样。
- `runAgentLoop` 按 `!!backend.startProcess` 传入。向后兼容(opts 可选,默认真以保 App 端现有行为 —— deviceBackend 已实现 startProcess)。

### D. CLI 跨轮记忆(#2)

**契约扩展**:
- `CliSpawnContext` 加 `resumeSessionId?: string`。
- `CliAgentAdapter` 加可选 `extractSessionId?(line: string): string | undefined`。
- `AgentSession` 加 `cliSessions?: Record<string, string>`(按 adapter.id 分槽)。

**claude**(supportsResume:true):
- `extractSessionId`:解析 stream-json,`msg.type === "system" && msg.subtype === "init"` 时取 `msg.session_id`。
- `buildSpawn`:`ctx.resumeSessionId` 存在时 args 前插 `"--resume", ctx.resumeSessionId`。
- runner:逐行调 `adapter.extractSessionId?.(line)`,首次命中记住;`runCliAgent` 返回 `{ fullText, cliSessionId? }`(原返回 string)。
- `runCliSession`:写 `session.cliSessions[adapter.id] = cliSessionId`;下轮读它塞进 ctx。

**codex/gemini**(supportsResume:false):`runCliSession` 层在有历史时,取 `session.messages` 近 6 轮,每条 content 截 500 字符,拼:

```
## Recent conversation
<role>: <text>
…

## Current request
<userMessage>
```

失效分析:server 重启/TTL 清理 → 内存 cliSessions 丢 → 下轮无 --resume = 全新会话 = 现状,无回归。claude 存储被清致 --resume 报错 → error 透传,不自动降级(backlog)。

### E. runner 空闲超时(#4)

stdout/stderr 每次 data 重置 120s 计时器;触发 → `killProcessTree(pid)` + `onEvent({type:"error", message:"CLI 无响应,已终止(120s 无输出)"})` + done。无全局超时(D6)。

### F. stderr 尾部(#5)

环形缓冲累积 stderr 尾部 2KB;仅当现有异常退出判定(`code!==0 && !aborted && !producedOutput && !errorEmitted`)成立时,把尾部附进 error message。成功路径维持现状(丢弃)。

## 4. 数据流(claude resume,每轮)

```
下轮 userMessage → runCliSession 读 session.cliSessions["claude-code"]
  → ctx.resumeSessionId → claudeCode.buildSpawn args 前插 --resume <id>
runCliAgent 逐行 → adapter.extractSessionId?(line) 首次命中 → 暂存
  (init 消息:{type:"system",subtype:"init",session_id:"..."})
proc close → runCliAgent 返回 { fullText, cliSessionId }
runCliSession → session.cliSessions["claude-code"] = cliSessionId
             → session.messages.push(assistant)
```

## 5. 测试策略(vitest,spawnFn/依赖注入)

- **processRegistry**:假 spawn — 起/停/同命令替换/自退摘除/shutdownAll 全清/listManaged 过滤;假 execInContainer 测 docker 分支(stop 走 pkill -f)。
- **processKill**:提取的 killProcessTree 行为不变(回归)。
- **nodeBackend**:假 registry 断言 startProcess/stopProcess 转发 + resolveHostCwd 复用。
- **runCommand**:假 backend 记录 opts — 默认 120s、clamp(1..600)、模型传参生效。
- **prompt**:supportsBackground 有/无两态 — runInBackground 字样出现/消失。
- **claude extractSessionId**:init 行→id、非 init→undefined、坏 JSON 安全。
- **runner**:返回对象形态;假 timers 测 120s 空闲超时(有输出重置/触发 kill+error);stderr 尾仅异常退出判定时附加。
- **runCliSession**:历史注入格式(6 轮/500 字/仅 supportsResume:false 且有历史);cliSessions 存取;下轮 buildSpawn 出现 --resume。

## 6. 验收标准

- `pnpm test:all` 全绿。
- 链路验收(后置,非合并阻塞):relay 模式 agent「起 dev server」→ runInBackground 被调 → 预览经隧道可看 → session 过 TTL 预览仍活 → stopProcess 能停;claude 两轮对话第二轮引用第一轮(记忆生效);npm install 超 30s 不被杀。

## 7. 执行顺序

1. killProcessTree 提共享 processKill.ts + processRegistry(TDD 核心)。
2. nodeBackend 接线 + shutdownAll 挂 server/daemon 入口(pm2 双信号)。
3. runCommand 超时参数(B)。
4. prompt 能力门控(C)。
5. runner 改造:返回对象 + 空闲超时 + stderr 尾(E/F)。
6. claude resume 全链(D)。
7. codex/gemini 历史注入(F/D)。
8. 文档:已知限制(#3/#6)+ plan.md 拆分路线状态更新。

依据:A 是被依赖的基座,先落且 TDD 最重;D 跨 runner/adapter/session 三处,放后面待 runner 稳定。

## 8. 风险与回滚

- processRegistry 退出清理与 pm2 信号语义:双信号(SIGTERM/SIGINT)+ exit 挂钩 + shutdownAll 幂等兜底。
- docker 分支 pkill -f 匹配过宽:容器隔离内可接受,spec 记录为已知简化。
- resume 内存态丢失:降级为现状(全新会话),无回归。
- 回滚:单分支未合并直接弃;各块相对独立,可单 commit revert。

## 9. 范围外

拆库本身(下一轮 spec)、#3(CLI 自起服务生命周期)、#6(codex/gemini env 清理)、resume 失败自动降级、后台进程输出捕获、listManaged 暴露为 agent 工具、App 侧 deviceBackend 改动(已有原生实现)。
