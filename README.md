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

本项目采用典型的 Monorepo 结构进行管理，分为移动端和后端服务两大模块：

```text
┌─────────────────────────────────┐
│  Android App (React Native)     │
│  ├── 核心交互部件: Markdown/Diff，终端 │
│  ├── 状态: 会话/离线/组件/工作区配置   │
└──────────┬──────────────────────┘
           │ WebSocket + HTTP (JWT Auth)
┌──────────▼──────────────────────┐
│  Server (Node.js)               │
│  ├── 工具代理: readFile, runCommand等 │
│  ├── 独立执行: Docker 沙箱调度池       │
│  ├── SQLite Sessions, 模型策略路由   │
└─────────────────────────────────┘
```

## 💻 技术栈

- **移动端**：React Native + Expo、react-native-markdown-display
- **服务端**：Node.js、WebSocket、Vercel AI SDK、Docker (dockerode)
- **数据库**：SQLite (better-sqlite3)
- **工程化**：pnpm workspace

## 🚀 快速开始

### 前提条件
- Node.js (>= 20.x)
- pnpm
- Docker (若运行云端服务模式需要)

### 安装依赖
```bash
# 1. 克隆代码
git clone https://github.com/your-repo/pocket-code.git
cd pocket-code

# 2. 安装 monorepo 下所有依赖
pnpm install
```

### 运行服务端 (Server)
1. 复制 `.env.example` (若有) 或者直接在 `packages/server/.env` 配置你必需的密钥：
   ```bash
   cp packages/server/.env.example packages/server/.env
   ```
2. 启动开发服务器：
   ```bash
   pnpm run dev:server
   ```

### 运行客户端 (App)
1. 开启另外一个终端面板：
   ```bash
   pnpm run dev:app
   ```
2. 启动后，扫码可使用 Expo Go 或按说明构建对应的模拟器/真机调试程序。

## 🗺️ 后续在做 (Roadmap)
- 更多计费系统方案（针对托管环境）
- iOS 版本全面体验调优
- 支持 SSH 直连至开发者私有服务器环境及工作流
- 语音输入集成（Whisper）
- 离线端侧小模型内置支持 (Ollama, llama.cpp 等)

## 📄 开源协议

[MIT License](./LICENSE)
