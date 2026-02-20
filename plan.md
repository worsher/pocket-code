# Pocket Code - 手机端 AI 编程代理

## 项目概述

手机端的 Claude Code 类工具，让开发者在手机上通过自然语言对话驱动 AI 编写、调试和管理代码。

- **平台**：Android 为主，后续考虑 iOS
- **场景**：日常开发 + 紧急修 Bug + 做成产品给别人用
- **核心理念**：对话驱动（非编辑器驱动），适配移动端交互

## 架构

```
┌─────────────────────────────────┐
│  Android App (React Native)     │
│  ├── 对话界面 (Markdown/代码)    │
│  ├── 文件树 + Diff 预览          │
│  ├── 终端输出展示                │
│  ├── 模型选择器                  │
│  └── 快捷操作栏                  │
└──────────┬──────────────────────┘
           │ WebSocket (JWT 认证)
┌──────────▼──────────────────────┐
│  Server (Node.js)               │
│  ├── WebSocket 服务 + JWT 认证   │
│  ├── Model Router (模型路由)     │
│  │   ├── SiliconFlow → DeepSeek/Qwen │
│  │   ├── Anthropic → Claude     │
│  │   ├── OpenAI → GPT-4o       │
│  │   └── Google → Gemini        │
│  ├── Vercel AI SDK (统一接口)    │
│  ├── Docker 容器隔离 (每用户)    │
│  ├── SQLite Session 持久化       │
│  └── Agent 工具层                │
│      ├── readFile / writeFile    │
│      ├── listFiles               │
│      ├── runCommand (Docker exec)│
│      └── Git 工具 (9 个)         │
└─────────────────────────────────┘
```

## 技术选型

| 层 | 选择 | 说明 |
|----|------|------|
| 移动端 | React Native + Expo | 跨平台，Expo Go 快速验证 |
| Markdown | react-native-markdown-display | AI 回复渲染 |
| 安全区域 | react-native-safe-area-context | 状态栏/导航栏适配 |
| 通信 | WebSocket | 流式输出 |
| AI 框架 | Vercel AI SDK | 统一多模型接口 + 工具调用 |
| 模型 API | SiliconFlow (硅基流动) | DeepSeek V3/R1, Qwen Coder |
| 容器 | Docker (dockerode) | 每用户独立沙箱 |
| 数据库 | SQLite (better-sqlite3) | Session 持久化 |
| 认证 | JWT (jsonwebtoken) | 用户认证 |
| 包管理 | pnpm workspace | monorepo |

## 项目结构

```
pocket-code/
├── package.json              # monorepo root
├── pnpm-workspace.yaml
├── docker/
│   ├── docker-compose.yml    # 生产部署编排
│   ├── Dockerfile.server     # Server 镜像
│   ├── Dockerfile.sandbox    # 用户沙箱镜像
│   └── nginx.conf            # Nginx 反代 + WSS
├── scripts/
│   └── deploy.sh             # VPS 部署脚本
├── packages/
│   ├── server/               # WebSocket + Agent 服务
│   │   ├── src/
│   │   │   ├── index.ts      # WebSocket 服务端 + JWT 认证
│   │   │   ├── agent.ts      # 多模型路由 + streamText + 工具调用
│   │   │   ├── tools.ts      # readFile/writeFile/listFiles/runCommand/Git
│   │   │   ├── auth.ts       # JWT 签发/验证 + 匿名注册
│   │   │   ├── db.ts         # SQLite Session 持久化
│   │   │   ├── docker.ts     # Docker 容器生命周期管理
│   │   │   └── gitCredentials.ts  # Git 凭证配置
│   │   └── .env              # API keys + JWT_SECRET + DOCKER_ENABLED
│   └── app/                  # React Native 移动端
│       ├── App.tsx           # 主界面 + QuickActions
│       └── src/
│           ├── hooks/
│           │   └── useAgent.ts       # WebSocket + JWT + 消息状态管理
│           ├── services/
│           │   ├── aiClient.ts       # 直调 AI API (极客模式)
│           │   ├── modelConfig.ts    # 模型配置
│           │   ├── localFileSystem.ts # 本地文件系统
│           │   ├── gitService.ts     # isomorphic-git 封装
│           │   └── expoFsAdapter.ts  # expo-file-system 适配器
│           ├── components/
│           │   ├── ChatMessage/      # 消息气泡 (Markdown + Diff + Terminal)
│           │   ├── ChatInput/        # 输入框
│           │   ├── DiffPreview/      # 文件修改 Diff 预览
│           │   ├── TerminalOutput/   # 命令输出展示
│           │   ├── QuickActions/     # 快捷操作栏
│           │   ├── TypingIndicator/  # 打字动画
│           │   ├── Settings/         # 设置页面
│           │   ├── SessionDrawer/    # 对话历史抽屉
│           │   ├── FileExplorer/     # 文件浏览器
│           │   └── FileViewer/       # 文件查看器
│           └── store/
│               ├── settings.ts       # 设置 + JWT token 持久化
│               └── chatHistory.ts    # 对话历史持久化
```

## 当前进度

### 已完成 (阶段〇 MVP)

- [x] pnpm monorepo 项目结构
- [x] WebSocket 服务端 (init/message 协议)
- [x] Vercel AI SDK 多模型路由 (8 个模型)
  - DeepSeek V3/R1, Qwen Coder (via SiliconFlow)
  - Claude Sonnet/Haiku (Anthropic)
  - GPT-4o/4o-mini (OpenAI)
  - Gemini Flash (Google)
- [x] Agent 工具：readFile, writeFile, listFiles, runCommand
- [x] Git 工具：clone, status, add, commit, push, pull, log, branch, checkout
- [x] 路径安全：safePath 防目录穿越
- [x] React Native 对话 UI (暗色主题)
- [x] 流式输出 + 工具调用展示
- [x] Markdown 渲染 (代码块、标题、列表、引用等)
- [x] 模型选择器 (Modal 弹窗切换)
- [x] 断线自动重连 (AppState 监听前后台切换)
- [x] 手动重连按钮 (Header 状态指示器可点击)
- [x] 安全区域适配 (react-native-safe-area-context)
- [x] 键盘弹出输入框跟随 (KeyboardAvoidingView behavior="padding")
- [x] Expo Go 真机验证通过

### 已完成 (阶段一 — 提前实现)

- [x] SERVER_URL 可配置 (设置页面)
- [x] 对话历史本地缓存 (AsyncStorage)
- [x] 流式输出取消请求 (abort)
- [x] 长消息折叠/展开
- [x] 代码块一键复制
- [x] 云端/极客双模式切换
- [x] Workspace 持久化 (~/.pocket-code/workspaces)
- [x] 文件树浏览器 (FileExplorer)
- [x] 代码查看器 (FileViewer)
- [x] 极客模式直调 AI API (XHR SSE 流式解析)
- [x] 极客模式本地文件系统 (expo-file-system)
- [x] 极客模式本地 Git (isomorphic-git)
- [x] Git 认证 (GitHub/Gitee/GitLab PAT)

### 已完成 (阶段一.五 — 多用户基础设施)

- [x] 用户认证系统 (JWT + 匿名注册)
  - Server: auth.ts — 签发/验证/匿名注册
  - App: WebSocket 连接时 register → auth → init 流程
  - Token 持久化到 AsyncStorage
- [x] Docker 容器隔离 (每用户独立 workspace + bash)
  - Server: docker.ts — 容器创建/执行/销毁/休眠
  - tools.ts: runCommand + Git 工具通过 Docker exec
  - Dockerfile.sandbox: Node.js 20 + git/npm/python3
  - 资源限制: 512MB 内存, 0.5 CPU
  - 空闲管理: 5min 暂停, 30min 销毁
- [x] VPS 部署配置
  - docker-compose.yml: Server + Nginx + Certbot
  - Dockerfile.server: 多阶段构建
  - nginx.conf: WebSocket 反代 + SSL
  - deploy.sh: 一键部署脚本
- [x] Session 持久化 (服务端 SQLite)
  - Server: db.ts — sessions 表 CRUD
  - agent.ts: runAgent 结束后自动保存
  - createSession 时从 DB 恢复历史
  - list-sessions / delete-session WebSocket 消息
- [x] Diff 预览 (writeFile 工具调用展示变更)
  - Server: writeFile 返回 oldContent/newContent
  - App: DiffPreview 组件 — 行级对比、新增/删除高亮
- [x] 终端输出优化
  - App: TerminalOutput 组件 — 命令输出专用展示
  - 超过 20 行自动折叠、一键复制
  - ChatMessage 中 runCommand 特殊渲染
- [x] 快捷操作栏
  - App: QuickActions 组件 — 输入框上方横向按钮
  - 预设: Commit, Push, Pull, Status, Test, Build, Install

---

## 剩余工作

### 阶段二：核心功能完善 (4 周)

#### 移动端

- [ ] Agent 思维链折叠展示
- [ ] 项目管理 (多项目切换)
- [ ] 离线消息缓存
- [ ] 流式输出 loading indicator 优化

#### 云端

- [ ] 用户认证系统 (GitHub OAuth 登录)
- [ ] Docker 容器池管理 (预热 + 负载均衡)
- [ ] 文件上传/下载
- [ ] 资源限制 (CPU/内存/磁盘配额，按用户)
- [ ] 智能模型路由 (根据 prompt 复杂度自动选模型)

### 阶段三：产品化 + 增强 (6-8 周)

- [ ] 计费系统 (按使用量/订阅)
  - 免费层：每天有限次 AI 交互，共享容器
  - 付费层：独立容器、更多额度、自定义 VPS
- [ ] 支持用户连接自己的 VPS (SSH 隧道模式)
- [ ] 本地极客模式 (Android Termux 内嵌，一键切换本地/云端)
- [ ] 本地模型支持 (Ollama / llama.cpp，离线可用)
- [ ] 语音输入 (Whisper)
- [ ] iOS 版本 (云端模式为主)
- [ ] 团队协作功能

---

## 支持的模型

| Key | 模型 | Provider | 适用场景 |
|-----|------|----------|---------|
| deepseek-v3 | DeepSeek V3 | SiliconFlow | 日常编码，性价比之王 (默认) |
| deepseek-r1 | DeepSeek R1 | SiliconFlow | 复杂推理 |
| qwen-coder | Qwen2.5-Coder-32B | SiliconFlow | 代码专精 |
| claude-sonnet | Claude Sonnet 4.5 | Anthropic | 高质量编程 |
| claude-haiku | Claude Haiku 4.5 | Anthropic | 快速轻量 |
| gpt-4o | GPT-4o | OpenAI | 通用编程 |
| gpt-4o-mini | GPT-4o Mini | OpenAI | 轻量任务 |
| gemini-flash | Gemini 2.5 Flash | Google | 轻量/免费额度大 |

## 关键风险与缓解

| 风险 | 缓解 |
|------|------|
| 服务器成本随用户增长 | 容器休眠策略 + 按需启动；付费转嫁成本 |
| 安全 (用户执行任意代码) | Docker 隔离 + 网络限制 + 资源配额 + 命令审计 |
| API 费用高 | 智能路由：简单任务用 DeepSeek，复杂任务用 Claude |
| 移动端代码阅读体验差 | 聚焦对话驱动交互，而非编辑器驱动 |

## 验证清单

阶段一.五完成后：
1. 手机访问公网地址 → 自动获取匿名账号 → 开始对话
2. 用户 A 和用户 B 同时使用 → 容器隔离，互不干扰
3. 关闭 App → 重新打开 → 对话从服务端恢复
4. 发送"创建一个 Express hello world 项目" → AI 自动创建文件 → 看到 Diff 预览
5. 发送"运行这个项目" → 看到终端输出（TerminalOutput 组件）
6. 点击 [Git Push] 快捷按钮 → 一键推送
