# @pocket-code/server

Pocket Code 的服务端:WebSocket agent 运行时、CLI 委托、后台进程管理。

## 执行层能力(后台进程 / CLI 委托)

- **后台进程**:`runInBackground`/`stopProcess` 经 `processRegistry`(daemon 级)管理,按 workspace 分组;
  session TTL 与断连**不**终止后台进程 —— dev server 活到显式 `stopProcess` 或 daemon 退出。
  同一 workspace 重复起同一命令会先杀旧再起新(防堆积)。
- **runCommand 超时**:默认 120s,模型可传 `timeoutSeconds`(1..600 秒,越界 clamp)。
- **CLI 委托记忆**:claude-code 用底层 `--resume`(捕获 stream-json init 的 session_id);
  codex/gemini 无原生续接,由 server 注入近 6 轮对话摘要(每条截 500 字符)。
- **已知限制**:
  - CLI(如 claude)在其内部 shell 里起的后台服务,生命周期归该 CLI 管,pocket-code 不追踪(请让 CLI 用自身后台机制)。
  - docker 模式下 `stopProcess` 用容器内 `pkill -f <command>` 匹配终止(匹配可能偏宽,容器隔离内可接受)。
  - **CLI 委托的 `cliSessions`(claude 的 --resume 会话 id)只存内存,不随 `saveSession`/`createSession` 持久化** —— server 进程重启或会话 TTL 清理后,claude 的续接链降级为全新会话(不报错、不崩溃,等同历史行为)。完整的 resume 持久化是后续 backlog。
