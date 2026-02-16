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
           │ WebSocket
┌──────────▼──────────────────────┐
│  Server (Node.js)               │
│  ├── WebSocket 服务              │
│  ├── Model Router (模型路由)     │
│  │   ├── SiliconFlow → DeepSeek/Qwen │
│  │   ├── Anthropic → Claude     │
│  │   ├── OpenAI → GPT-4o       │
│  │   └── Google → Gemini        │
│  ├── Vercel AI SDK (统一接口)    │
│  └── Agent 工具层                │
│      ├── readFile / writeFile    │
│      ├── listFiles               │
│      └── runCommand (bash)       │
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
| 包管理 | pnpm workspace | monorepo |

## 项目结构

```
pocket-code/
├── package.json              # monorepo root
├── pnpm-workspace.yaml
├── packages/
│   ├── server/               # WebSocket + Agent 服务
│   │   ├── src/
│   │   │   ├── index.ts      # WebSocket 服务端，处理 init/message
│   │   │   ├── agent.ts      # 多模型路由 + streamText + 工具调用
│   │   │   └── tools.ts      # readFile/writeFile/listFiles/runCommand
│   │   └── .env              # API keys (SILICONFLOW_API_KEY 等)
│   └── app/                  # React Native 移动端
│       ├── App.tsx           # 主界面：Header + 消息列表 + 输入框 + 模型选择器
│       └── src/
│           ├── hooks/
│           │   └── useAgent.ts       # WebSocket 连接 + 消息状态管理
│           └── components/
│               ├── ChatMessage/      # 消息气泡 (Markdown 渲染 + 工具调用展示)
│               └── ChatInput/        # 输入框
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

### 已知问题

- [ ] workspace 存储在 `/tmp`，服务器重启后丢失
- [ ] 对话记录不持久化，关 App 后丢失
- [ ] 无法查看 workspace 文件（只能通过对话让 AI 读）
- [ ] SERVER_URL 硬编码为 LAN IP

---

## 剩余工作

### 阶段一：云端部署 + UI 增强 (2 周)

#### 云端

- [ ] VPS 部署 (2C4G)，安装 Docker + Node.js
- [ ] Docker 容器隔离 (每用户独立 workspace + bash 环境)
- [ ] Workspace 持久化 (挂载到持久磁盘，非 /tmp)
- [ ] Session 持久化 (对话历史入库，关 App 后恢复)
- [ ] 用户认证 (JWT)
- [ ] 云端/本地双模式切换

#### 移动端

- [ ] SERVER_URL 可配置 (设置页面或首次启动输入)
- [ ] 对话历史本地缓存 (AsyncStorage)
- [ ] 流式输出优化：loading indicator、取消请求
- [ ] 长消息折叠/展开
- [ ] 代码块一键复制按钮

### 阶段二：核心功能完善 (4 周)

#### 移动端

- [ ] 文件树浏览器 (查看 workspace 文件结构)
- [ ] 代码查看器 + 语法高亮
- [ ] Diff 预览 (Agent 修改文件前用户确认)
- [ ] 终端输出展示面板
- [ ] 快捷操作栏 (git commit/push, npm test, npm run build)
- [ ] Agent 思维链折叠展示
- [ ] 项目管理 (多项目切换)
- [ ] 离线消息缓存

#### 云端

- [ ] 用户认证系统 (GitHub OAuth 登录)
- [ ] Docker 容器池管理 (创建/销毁/休眠，5min 无操作暂停)
- [ ] Git 集成 — OAuth + PAT 双轨制认证
  - GitHub: OAuth App, scope `repo`
  - Gitee: 第三方应用, scope `projects`
  - GitLab: Application, scope `read_repository, write_repository`
  - 容器内通过 `~/.git-credentials` 注入 token
  - Token AES 加密存储，容器销毁时清除
- [ ] 文件上传/下载
- [ ] 资源限制 (CPU/内存/磁盘配额)
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

阶段一完成后：
1. 手机发送"创建一个 Express hello world 项目" → AI 自动创建文件
2. 发送"运行这个项目" → 看到终端输出
3. 发送"添加一个 /users 路由" → 看到 diff 预览 → 确认修改
4. 发送"git commit 并 push" → 完成 Git 操作
5. 网络断开后重连 → Session 恢复
