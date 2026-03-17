# Pocket Code 📱

> 你的贴身 AI 编程代理 —— 手机端的 Claude Code

Pocket Code 是一款专为移动端设计的 AI 编程代理应用。通过自然语言对话，它允许开发者在手机上直接编写、调试、分析和管理代码。无论是日常开发、紧急修复 Bug，还是将灵感快速转化为代码，Pocket Code 都能为你提供全方位的支持。

## ✨ 核心特性

- **🤖 多模型支持与智能路由**
  - 集成 Vercel AI SDK，支持多种主流大模型（DeepSeek V3/R1、Qwen Coder、Claude 3.5 Sonnet/Haiku、GPT-4o、Gemini 2.5 Flash 等）。
  - 支持按需手动切模，也拥有智能路由机制可以根据 Prompt 的复杂度自动选择最匹配的模型，以达到成本与效果的最佳平衡。

- **🌩️ 云端 / 极客双模式切换**
  - **云端模式**：服务端内置 Docker 沙箱，为每个用户分配独立隔离的容器环境进行代码编辑和终端命令执行。
  - **极客模式**：数据完全留存在本地，支持配置属于你自己的 API Keys，内置本地文件系统和基于 `isomorphic-git` 的本地版 Git 工具能力，不依赖云端沙箱。

- **🛠️ 极致移动端开发体验**
  - **对话即开发**：非传统编辑器驱动，纯对话式 UI 交互。
  - **组件化呈现**：支持流式输出响应、Markdown 高亮代码块、Diff 文件变更实时对比、清晰的终端执行日志展示（Terminal Output）及代码文件浏览器。
  - **AI 思维链可见**：支持 DeepSeek R1 的推理模型，展示原生可折叠的 `<think>` 推理过程与字数。
  - **高频操作快捷栏**：内置 Git 操作（Commit, Push, Pull）、测试、构建等一键唤起的快捷执行按钮。

- **📸 视觉与多模态**
  - 支持手机拍摄 Bug 截图、手绘白板架构图，直接发给 AI 分析处理。系统会自动感知图片并切换至多模态大模型（Claude/GPT-4o/Gemini）进行识别。

- **📂 工作区与断线支持**
  - 支持多项目切换管理，每个项目支持自定义系统指令集（Project System Prompt）。
  - 含有对话历史本地缓存与离线消息队列机制，断网状态下照常输入排队，重连后自动发送。
  - 全文消息搜索机制及长对话任意分支回滚重开（Edit & Resend）功能。

## 🏗️ 架构概览

本项目采用 pnpm workspace Monorepo 结构，包含以下模块：

```text
packages/
  app/      - Expo React Native 移动端
  server/   - Node.js 后端 (AI 调用 + 工具执行)
  daemon/   - 内网代理 (连接 Relay，本地执行 Server 核心逻辑)
  relay/    - VPS 中继服务 (消息转发，无业务逻辑)
  wire/     - 共享协议定义 (Zod schemas)
```

支持两种连接模式：

### 模式一：局域网直连 (Server)

手机与 Server 在同一局域网内，通过 WebSocket 直连。

```text
App  ──WebSocket──>  Server (内网, :3100)
```

### 模式二：公网中继 (Relay)

通过 VPS 上的 Relay 中继，实现手机从公网安全连接到内网开发机，无需暴露本地端口或公网 IP。

```text
App  ──>  Relay (VPS公网, :3200)  ──>  Daemon (内网开发机)
```

> Relay 只做消息转发，不执行任何业务逻辑。Daemon 内嵌了 Server 的核心处理逻辑，Relay 模式下不需要单独启动 Server。

## 💻 技术栈

- **移动端**：React Native + Expo、react-native-markdown-display
- **服务端**：Node.js、WebSocket、Vercel AI SDK、Docker (dockerode)
- **中继/代理**：WebSocket、HMAC-SHA256 认证、JWT 设备令牌
- **协议层**：Zod schema 验证
- **数据库**：SQLite (sql.js)
- **工程化**：pnpm workspace

## 🚀 快速开始

### 前提条件
- Node.js (>= 20.x)
- pnpm
- Docker (若运行云端沙箱模式需要)

### 安装依赖
```bash
git clone https://github.com/your-repo/pocket-code.git
cd pocket-code
pnpm install
```

### 方式一：局域网直连

```bash
# 启动 Server (需要 AI API Key)
SILICONFLOW_API_KEY=sk-xxx pnpm dev:server
```

App 设置中选择「局域网直连」，填入 Server 地址（如 `ws://192.168.1.100:3100`）。

### 方式二：公网中继 (Relay + Daemon)

```bash
# 1. 构建 (按依赖顺序)
pnpm --filter @pocket-code/wire build
pnpm --filter @pocket-code/server build
pnpm --filter @pocket-code/relay build
pnpm --filter @pocket-code/daemon build

# 2. 在 VPS 上启动 Relay
pnpm dev:relay                  # 默认监听 ws://0.0.0.0:3200

# 3. 在开发机上启动 Daemon
RELAY_URL=ws://your-vps:3200 \
SILICONFLOW_API_KEY=sk-xxx \
pnpm dev:daemon
```

Daemon 启动后终端显示 **8 位配对码**（5 分钟有效，过期自动刷新）。在 App 中：

1. 设置 → 工作区 → 选择「公网中继 (Relay)」
2. 填入 Relay 地址（如 `ws://your-vps:3200`）
3. 输入 Daemon 显示的配对码，点击「配对」

配对成功后即可正常使用，后续无需再次配对（设备 JWT 有效期 365 天）。

### 运行 App
```bash
pnpm dev:app
```
启动后使用 Expo Go 扫码，或构建模拟器/真机调试包。

## 🔐 安全机制

### 设备配对
- 8 位字母数字混合码（排除 I/O 避免混淆，34^8 约 1.8 万亿种组合）
- 5 分钟有效期，过期自动刷新新码
- 连续 5 次输入错误后配对码自动销毁
- 配对成功签发长期设备 JWT

### Daemon 注册认证（可选）
当 Relay 和 Daemon 都配置 `RELAY_SECRET` 环境变量时，启用 HMAC-SHA256 注册认证：
- Daemon 注册时计算 `HMAC-SHA256(machineId + timestamp, RELAY_SECRET)`
- Relay 验证签名及 5 分钟时间窗口（防重放攻击）
- 未配置时不验证，适用于开发环境

## ⚙️ 环境变量

### Server / Daemon 共用

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `SILICONFLOW_API_KEY` | SiliconFlow API Key (DeepSeek/Qwen) | - |
| `OPENAI_API_KEY` | OpenAI API Key | - |
| `IFLOW_API_KEY` | iFlow API Key | - |
| `DB_PATH` | 数据库文件路径 | `~/.pocket-code/pocket-code.db` |

### Daemon 专用

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `RELAY_URL` | Relay 服务器地址 | `ws://localhost:3200` |
| `MACHINE_NAME` | 机器显示名称 | 系统 hostname |
| `POCKET_HOME` | 配置目录 | `~/.pocket-code` |
| `RELAY_SECRET` | HMAC 注册认证密钥 (可选) | 不验证 |

### Relay 专用

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 监听端口 | `3200` |
| `RELAY_SECRET` | HMAC 注册认证密钥 (可选) | 不验证 |

## 🗺️ 后续在做 (Roadmap)
- 更多计费系统方案（针对托管环境）
- iOS 版本全面体验调优
- 支持 SSH 直连至开发者私有服务器环境及工作流
- 语音输入集成（Whisper）
- 离线端侧小模型内置支持 (Ollama, llama.cpp 等)

## 📄 开源协议

[MIT License](./LICENSE)
