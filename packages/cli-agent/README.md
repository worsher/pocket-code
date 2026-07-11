# @pocket-code/cli-agent

把 coding-agent CLI(claude-code / codex / gemini-cli)作为子进程驱动,把它们的 NDJSON 输出归一化为统一的 `CliEvent` 流。零运行时依赖。

## 用法

```ts
import { cliAdapters, runCliAgent } from "@pocket-code/cli-agent";

const { fullText, cliSessionId } = await runCliAgent(
  cliAdapters["claude-code"],
  "修复 src/app.ts 里的类型错误",
  { workspace: "/abs/path/to/project", resumeSessionId: undefined },
  (e) => console.log(e)   // CliEvent 流:text-delta / reasoning-delta / tool-call / tool-result / file-changed / usage / error / done
);
// claude 支持续接:把 cliSessionId 存起来,下轮放进 ctx.resumeSessionId 即 --resume。
```

## 契约

- `CliAgentAdapter`:`buildSpawn`(构造子进程参数)+ `parseLine`/`createParser`(逐行归一化)+ 可选 `extractSessionId`(捕获底层会话 id)。
- `CliEvent`:8 变体判别联合(纯 TS 类型);运行时校验用 `isCliEvent`。
- runner 内置:120s **空闲**超时(有输出即重置)、abort 信号、进程树终止(`killProcessTree`,跨平台)、stderr 尾 2KB 附错误。

## 各适配器要点

- **claude-code**:`--output-format stream-json`;`supportsResume: true`(捕获 init 消息的 session_id → 下轮 `--resume`)。spawn 前清除宿主 shell 的 `ANTHROPIC_*` 环境变量,防止残留配置劫持 CLI(真机案例:`ANTHROPIC_MODEL` 指向已下线模型 → 404)。
- **codex / gemini-cli**:无原生续接(`supportsResume: false`),跨轮记忆由调用方注入(如把近几轮对话摘要拼进 userMessage)。
- gemini 用 `createParser`(每次运行新建解析器,状态互不串扰)。

## 测试

```bash
pnpm --filter @pocket-code/cli-agent test        # 单测(e2e 默认 skip)
RUN_CLI_E2E=1 pnpm --filter @pocket-code/cli-agent test   # 含真实 CLI e2e(需本机装有对应 CLI)
```
