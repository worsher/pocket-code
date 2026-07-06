# Pocket Code — 项目现状与路线图

> 本文件是项目的**现状索引**。架构与决策的单一真相源是
> `docs/superpowers/specs/2026-06-02-pocket-code-重构设计.md`（下称"重构设计"），
> 各阶段的详细设计在 `docs/superpowers/specs/`、实现计划在 `docs/superpowers/plans/`。
> （2026-07-06 重写：原文件描述的是重构前的"App→云端 Server"架构，已过时。）

## 一句话定位

个人编程代理：手机为主控端，通过配对的开发机跑 agent（claude-code 等 CLI）与 dev server，
改代码、真正跑起来、在手机上直接看到运行效果。代码同步零污染（git 影子快照），远程经中继不暴露端口。

## 当前架构（模式 A：配对开发机，主力路径）

```
┌─ 手机 App (React Native/Expo) ─────────────┐
│ Chat/Diff/Terminal/Files/Preview            │
│ 只消费归一化 AgentEvent 流(wire 单一契约)     │
│ useAgent(组合层) ← chatReducer(纯函数)       │
│                 ← ServerConnection(传输层)   │
└──── LAN 直连 ws ──┬── 或 Relay 中继 ────────┘
                    │       │
                    │  ┌────▼─────────────┐
                    │  │ Relay (VPS 公网)   │ 纯转发+HTTP/WS 隧道
                    │  │ 强制 RELAY_SECRET  │ 响应/隧道/心跳身份绑定
                    │  └────┬─────────────┘
               ┌────▼───────▼──────────────┐
               │ Daemon (开发机,内嵌 server) │
               │ claude-code CLI / AI-SDK    │
               │ 影子快照同步 / dev server    │
               └─────────────────────────────┘
```

- **协议**：`@pocket-code/wire` 是全部消息的单一真相源（入站 WsMessage、出站 ServerOutbound、
  归一化 AgentEvent、配对/中继信封、HTTP+WS 隧道帧）；relay/daemon 边界 safeParse。
- **同步**：git 影子快照（`refs/pocket-code/*`，零污染用户分支）+ 活动文件快路径。
- **预览**：dev server 跑开发机；局域网直连或经 relay 反向隧道（HTTP + HMR WebSocket）。

## 已完成（重构后主线）

| 阶段 | 内容 | Spec/Plan |
|---|---|---|
| P1 | 编译干净 + CI 门禁 + 真 bug 修复 | plans/2026-06-02-p1 |
| P2 | wire 协议统一 + 归一化 AgentEvent 契约 | plans/2026-06-03-p2 |
| P3 | CliAgentAdapter + claude-code 适配器 + 运行器 | plans/2026-06-03-p3a/p3b |
| P4 | git 影子快照同步（服务端核心 + sync 协议 + 手机侧拉取） | plans/2026-06-03-p4/p4b |
| P5 | 中继 HTTP 隧道预览（含绝对路径 cookie 路由） | plans/2026-06-03-p5 |
| P6a | relay 远程安全加固（强制 RELAY_SECRET / 响应身份绑定 / 边界 safeParse） | specs+plans/2026-07-05-p6a |
| P6b | App 切归一化 AgentEvent（删 StreamEvent 与 bridge / 出站 schema / useAgent 拆三层 / geek 共用 reducer） | specs+plans/2026-07-05-p6b |
| P7 | HMR 热更新隧道（WS upgrade 路由拆分 / WsTunnelHub / daemon 本地 ws 客户端） | specs+plans/2026-07-05-p7 |

## 待办（按优先级）

1. **真机验收**：P6a/P6b/P7 三组清单，见 `docs/真机验收指南.md`。
2. **合并 refactor/architecture-redesign → master**（验收通过后）；顺带让 CI 生效。
3. **codex / gemini-cli 适配器**：gemini 事件已归一化但仍是 cliRunner 遗留实现（未进 adapter 架构、未真机验证）；codex 未接。
4. **agent-core（模式 C 端侧 agent）**：合并 server/agent.ts 与 app geekLoop/aiClient 为同构包（三套 loop 收编的最后一步）。
5. **esbuild-wasm 离线前端预览**（模式 B/C）。
6. **端侧 shell spike**（proot/Alpine over SELinux，真机验证）。
7. **iOS**。

## 安全后置（多用户/公开部署前必做）

- App→relay 连接鉴权（`list-machines` 当前对任意连接可见）
- per-daemon TOFU 指纹（当前靠共享 RELAY_SECRET）
- wss/TLS 代码层强制（当前靠 nginx，见部署文档）
- SaaS 全家桶：Docker 沙箱默认开、配额完整化、凭证加密、审计、计费

## 文档索引

- 部署：`docs/deployment-relay-daemon.md`（Relay VPS + Daemon 开发机，systemd/pm2/nginx）
- 真机验收：`docs/真机验收指南.md`
- 重构总设计：`docs/superpowers/specs/2026-06-02-pocket-code-重构设计.md`
