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
| P8 | codex/gemini-cli 适配器 + 注册表路由 + 删 cliRunner | specs+plans/2026-07-06-p8 |
| — | DeepSeek V4 升级（Pro/Flash,默认与 auto 路由随迁） | specs/2026-07-06-deepseek-v4 |
| P9 | agent-core 同构包+双侧接入,三套 loop 收编完成 | specs+plans/2026-07-06-p9 |
| P10 | client-core 同构包(三模块正典迁移+去 RN 化)+Web 端 Chat/Files/Diff | specs+plans/2026-07-10-p10 |
| — | relay 拆分:protocol-core 拆层+tunnel-client(pocket-tunnel CLI)+发布就绪+DISCOVERY/TUNNEL_TOKEN 加固 | specs+plans/2026-07-10-relay拆分 |

## 待办（按优先级）

1. ~~**P11:RN App 切换消费 client-core**,删除三个冻结副本(services/serverConnection.ts、services/relayClient.ts、hooks/chatReducer.ts 及其测试)~~(✅ 2026-07-11 完成,连带 iOS 平台隔离:iOS 默认 relay、local 置灰、终端 Tab 不渲染;spec/plan 见 docs/superpowers/{specs,plans}/2026-07-11-内核统一-iOS平台隔离*)。
2. **esbuild-wasm 离线前端预览**（模式 B/C）。
3. **端侧 shell spike**（proot/Alpine over SELinux，真机验证）。
4. **iOS**。
5. 小增强：DeepSeek V4 think 参数透传、codex MCP/todo 事件精细渲染。

## 拆分路线（评估结论,详见 specs/2026-07-06-p9 第一部分）

单人期不拆仓库,包边界按"随时可拆"标准维护。触发信号:开源/第三方复用/多人协作。
- **relay** → 已达"随时可迁"终态(specs/2026-07-10-relay拆分):依赖图自足(protocol-core+ws)、发布件齐、隧道入口可鉴权;真正开源仅剩 git subtree 迁移+npm 发布。
- **cli 适配层** → 独立 OSS 库(驱动 claude-code/codex/gemini 的归一化事件流):约 1 天,价值最高。
- **agent-core** → P9 即按可拆标准建包(运行时零依赖)。
- **client-core + Web 端** → P10 候选。

## 安全后置（多用户/公开部署前必做）

- App→relay 连接鉴权（list-machines 对任意连接可见;纯隧道部署可用 `RELAY_DISCOVERY=off` 整体关闭,自用部署维持现状）
- per-daemon TOFU 指纹（当前靠共享 RELAY_SECRET）
- wss/TLS 代码层强制（当前靠 nginx，见部署文档）
- SaaS 全家桶：Docker 沙箱默认开、配额完整化、凭证加密、审计、计费

## 文档索引

- 部署：`docs/deployment-relay-daemon.md`（Relay VPS + Daemon 开发机，systemd/pm2/nginx）
- 真机验收：`docs/真机验收指南.md`
- 重构总设计：`docs/superpowers/specs/2026-06-02-pocket-code-重构设计.md`
