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
│   ├── server/               # HTTP+WebSocket 服务
│   │   ├── src/
│   │   │   ├── index.ts      # HTTP+WS 混合服务端 + JWT 认证
│   │   │   ├── agent.ts      # 多模型路由 + streamText + 工具调用
│   │   │   ├── tools.ts      # readFile/writeFile/listFiles/runCommand/Git
│   │   │   ├── auth.ts       # JWT 签发/验证 + 匿名注册 + GitHub OAuth
│   │   │   ├── oauth.ts      # GitHub OAuth 流程
│   │   │   ├── db.ts         # SQLite Session/用户/配额持久化
│   │   │   ├── docker.ts     # Docker 容器生命周期管理
│   │   │   ├── containerPool.ts  # Docker 容器池 (预热/分配/回收)
│   │   │   ├── resourceLimits.ts # 用户资源配额 (free/basic/pro)
│   │   │   ├── modelRouter.ts    # 智能模型路由 (基于规则)
│   │   │   ├── fileTransfer.ts   # 文件上传/下载 HTTP 端点
│   │   │   └── gitCredentials.ts # Git 凭证配置
│   │   └── .env              # API keys + JWT_SECRET + DOCKER_ENABLED
│   └── app/                  # React Native 移动端
│       ├── App.tsx           # 主界面 + QuickActions
│       └── src/
│           ├── hooks/
│           │   ├── useAgent.ts       # WebSocket + JWT + 消息状态 + 离线队列
│           │   └── useNetworkStatus.ts # 网络状态监控
│           ├── services/
│           │   ├── aiClient.ts       # 直调 AI API (极客模式 + 思维链解析)
│           │   ├── modelConfig.ts    # 模型配置 (含 auto 路由)
│           │   ├── oauth.ts          # GitHub OAuth 客户端
│           │   ├── fileTransfer.ts   # 文件上传/下载客户端
│           │   ├── offlineQueue.ts   # 离线消息队列
│           │   ├── localFileSystem.ts # 本地文件系统
│           │   ├── gitService.ts     # isomorphic-git 封装
│           │   └── expoFsAdapter.ts  # expo-file-system 适配器
│           ├── contexts/
│           │   └── ProjectContext.tsx # 项目管理 Context
│           ├── components/
│           │   ├── ChatMessage/      # 消息气泡 (Markdown + Diff + Terminal)
│           │   ├── ChatInput/        # 输入框 + 附件按钮
│           │   ├── StreamingIndicator/ # 流式状态指示器 (6种阶段)
│           │   ├── ThinkingBlock/    # AI 思维链折叠展示
│           │   ├── DiffPreview/      # 文件修改 Diff 预览
│           │   ├── TerminalOutput/   # 命令输出展示
│           │   ├── QuickActions/     # 快捷操作栏
│           │   ├── TypingIndicator/  # 打字动画 (已被 StreamingIndicator 替代)
│           │   ├── Settings/         # 设置页面 (含 GitHub 登录)
│           │   ├── SessionDrawer/    # 对话历史抽屉 (含项目切换)
│           │   ├── ProjectDrawer/    # 项目管理抽屉
│           │   ├── FileExplorer/     # 文件浏览器
│           │   └── FileViewer/       # 文件查看器
│           └── store/
│               ├── settings.ts       # 设置 + JWT token + GitHub 持久化
│               ├── projects.ts       # 项目数据持久化
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

### 已完成 (阶段二 — 核心功能完善)

#### 移动端

- [x] 流式输出 loading indicator 优化
  - App: StreamingIndicator 组件 — 6 种阶段状态 (connecting/thinking/generating/tool-calling/tool-running/idle)
  - 不同阶段展示不同动画和文案，工具执行时显示工具名和计时器
- [x] Agent 思维链折叠展示
  - App: ThinkingBlock 组件 — 紫色左侧竖线，折叠/展开，显示字数
  - useAgent: 支持 reasoning-delta 事件 + `<think>` 标签解析状态机
  - aiClient: DeepSeek R1 原生 reasoning_content 和 `<think>` 标签双模式
- [x] 项目管理 (多项目切换)
  - App: ProjectContext (React Context) — 全局项目状态
  - App: ProjectDrawer 组件 — 创建/切换/删除项目
  - SessionDrawer 中集成 ProjectDrawer
  - store/projects.ts — 项目数据 AsyncStorage 持久化
- [x] 离线消息缓存
  - App: offlineQueue.ts — 离线消息入队/出队/重试/清理
  - App: useNetworkStatus hook — NetInfo 网络状态监控
  - useAgent: sendMessage 离线时入队，WebSocket 重连后自动 replay

#### 云端

- [x] 用户认证系统 (GitHub OAuth 登录)
  - Server: oauth.ts — GitHub OAuth 完整流程 (code exchange → JWT → deep link)
  - Server: auth.ts 增加 githubId/githubLogin 字段
  - Server: index.ts 改造为 HTTP+WS 混合服务器
  - App: services/oauth.ts — expo-web-browser OAuth 客户端
  - App: SettingsScreen — GitHub 登录/退出按钮 + 头像展示
- [x] Docker 容器池管理 (预热 + 负载均衡)
  - Server: containerPool.ts — 容器池生命周期 (warming→ready→assigned→cooling)
  - 可配置 POOL_MIN_READY / POOL_MAX_TOTAL
  - 自动维护循环：空闲回收、预热补充
  - docker.ts: 集成容器池 (POOL_ENABLED=true 时启用)
- [x] 文件上传/下载
  - Server: fileTransfer.ts — HTTP 端点 /api/files/upload, /api/files/download
  - App: services/fileTransfer.ts — expo-file-system 上传/下载客户端
  - App: ChatInput — 附件按钮 (+) 调用 DocumentPicker
  - 安全：JWT 认证 + 路径穿越防护 + 大小限制 (50MB)
- [x] 资源限制 (CPU/内存/磁盘配额，按用户)
  - Server: resourceLimits.ts — 三级配额 (free/basic/pro)
  - Server: db.ts — user_quotas 表, users 表
  - Server: docker.ts — 根据配额动态设置容器资源
  - Server: index.ts — 消息处理前 checkQuota + incrementUsage
- [x] 智能模型路由 (根据 prompt 复杂度自动选模型)
  - Server: modelRouter.ts — 基于规则的 analyzePrompt()
  - 4 级复杂度: simple→deepseek-v3, medium→deepseek-v3, complex→claude-sonnet, reasoning→deepseek-r1
  - App: modelConfig.ts 增加 "auto" 模型选项
  - agent.ts: modelKey="auto" 时调用路由，发送 model-selected 事件

---

## 剩余工作

### 阶段二.五：个人使用体验完善 (3-4 周)

#### 高频刚需

- [ ] 图片/截图输入 (多模态)
  - 手机拍 Bug 截图、白板设计图直接发给 AI 分析
  - App: expo-image-picker 拍照/相册选取，base64 编码随消息发送
  - Server: 转发图片给支持视觉的模型 (Claude/GPT-4o/Gemini)
  - 智能路由: 检测到图片时自动选择多模态模型
- [ ] 对话搜索
  - 全文搜索历史对话内容（消息文本 + 工具调用结果）
  - App: SearchBar 组件 + chatHistory 增加搜索接口
  - 高亮匹配关键词，点击跳转到对应对话
- [ ] 自定义项目指令 (Project System Prompt)
  - 每个项目配置专属 system prompt（类似 CLAUDE.md）
  - AI 自动了解项目技术栈、代码风格、命名约定
  - App: Project 设置页增加指令编辑器
  - Server/极客模式: 在对话 system message 中注入项目指令
- [ ] 多轮对话分支 (Edit & Resend)
  - 从某条消息重新发起对话，不用重新描述上下文
  - App: 长按消息 → "从此处重新对话"
  - chatHistory: 支持 fork 对话，保留原始分支

#### 体验提升

- [ ] 代码块语法高亮
  - 替换或增强 react-native-markdown-display 的代码块渲染
  - 支持主流语言语法高亮 (JS/TS/Python/Go/Rust 等)
- [ ] 快捷指令自定义
  - 除了预设 Commit/Push/Pull，用户可自定义常用命令
  - App: QuickActions 支持编辑/添加/排序/删除
  - 按项目存储自定义指令
- [ ] 后台任务通知
  - 长时间运行的命令 (build/test/deploy) 后台执行
  - 完成后推送本地通知 (expo-notifications)
  - 锁屏状态下也能收到结果
- [ ] 文件变更汇总视图
  - AI 本轮对话修改了哪些文件，单独列出 (类似 Git changes)
  - App: ChangeSummary 组件 — 文件列表 + 增删行数统计
  - 点击可查看 Diff

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
