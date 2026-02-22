# Pocket Code 本地 Linux 执行器 — 混合架构方案

> 状态: 规划中 | 创建日期: 2026-02-22

## Context

pocket-code 需要一个类似 Termux 的本地代码执行环境，嵌入移动端 App，支持 Python/Node.js/C/C++/Go。核心挑战：

- **Android API 29+**: W^X 限制，禁止从 app data 目录 execve() 执行二进制文件
- **iOS**: 严禁 fork()/exec()，禁止 JIT，App Store 禁止下载执行外部代码
- **跨平台一致性**: 需要统一的执行抽象层

## 架构总览: WASM 虚拟化 + Native 降级双轨

```
┌─────────────────────────────────────────────────────────────────┐
│  React Native App                                               │
│  ┌──────────────┐  ┌──────────────┐                             │
│  │ AI Chat Mode │  │ Terminal Mode │  (Tab 切换)                │
│  └──────┬───────┘  └──────┬───────┘                             │
│         │                  │                                     │
│  ┌──────▼──────────────────▼──────────────────────────────────┐ │
│  │  Unified Executor Service (TypeScript)                      │ │
│  │  ├── exec(lang, code) → {stdout, stderr, exitCode}         │ │
│  │  ├── spawnShell() → interactive PTY stream                  │ │
│  │  └── installRuntime(lang) → Promise                         │ │
│  └────────────────────────┬───────────────────────────────────┘ │
│                            │                                     │
│  ┌────────────────────────▼───────────────────────────────────┐ │
│  │  执行路由层                                                  │ │
│  │  ├── WASM Engine (iOS + Android 双平台)                       │ │
│  │  │   ├── Python  → cpython.wasm (WASI, 官方 tier 2)         │ │
│  │  │   ├── C/C++   → clang.wasm (Wasmer 提供)                 │ │
│  │  │   └── JS/Node → wasmedge-quickjs.wasm (Node.js API 兼容) │ │
│  │  │                                                           │ │
│  │  └── Native Engine (Android only, lib*.so 通道)              │ │
│  │      ├── Go      → libgo.so (Go 工具链)                      │ │
│  │      └── Shell   → proot + Alpine (完整 Linux 环境)          │ │
│  └────────────────────────┬───────────────────────────────────┘ │
│                            │                                     │
│  ┌────────────────────────▼───────────────────────────────────┐ │
│  │  Terminal Renderer (libvterm + Native Canvas)                │ │
│  │  ├── libvterm C 状态机 (已有源码)                             │ │
│  │  ├── JNI/FFI → 读取字符栅格                                   │ │
│  │  └── Android Canvas / iOS Metal 渲染                         │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

## 可行性评估

### WASM 编译器现状（2025 实测）

| 语言 | WASM 可行性 | 方案 | 备注 |
|------|------------|------|------|
| Python | ✅ 可行 | cpython 3.13+ WASI tier 2 | 无 subprocess/socket，stdlib 有裁剪 |
| C/C++ | ✅ 可行 | Wasmer clang-wasm 包 | 编译 C→WASM，在 WASM 内运行 |
| JS/Node | ✅ 可行 | WasmEdge QuickJS→WASM | QuickJS 引擎，实现大量 Node.js API（fs/http/path），双平台 |
| Go | ❌ 不可行 | Go 工具链无法在 WASM 内运行 | Android lib*.so / iOS 云端降级 |

### React Native WASM 集成

- **Polygen**（Callstack 开源）: 使用 wasm2c 将 .wasm 转为 C 代码，编译为原生模块
- 绕过 iOS JIT 限制（AOT 编译）
- GitHub: https://github.com/callstackincubator/polygen

### Android Native 通道 (lib*.so)

- 官方认可方案：将二进制放入 APK 的 `lib/<arch>/` 目录
- 安装后提取到 `/data/app/*<package>/lib/<arch>/`，有执行权限
- Termux 长期方案也将迁移至此

## 分阶段实现计划

### Phase 1: WASM 执行引擎 MVP（Python + C + JS）

**目标**: AI 可通过 runCommand 在本地执行 Python、C 和 JS 代码，iOS/Android 双平台。

#### 1.1 集成 WASM 运行时

- 使用 **Polygen** (wasm2c) 将 cpython.wasm 和 clang.wasm 预编译为 native module
- 或使用 **WAMR**（C 库，~200KB）嵌入为 Expo Native Module，AOT 模式运行
- 推荐 **WAMR** 路线（更灵活，运行时加载 .wasm 文件而非编译期固定）

**新建** `packages/app/modules/pocket-terminal-module/`:
```
pocket-terminal-module/
├── expo-module.config.json
├── src/index.ts                          # TS 接口
├── android/
│   ├── build.gradle.kts
│   ├── CMakeLists.txt                    # 编译 WAMR + libvterm
│   └── src/main/
│       ├── java/expo/modules/terminal/
│       │   ├── PocketTerminalModule.kt   # Module 定义
│       │   ├── WasmEngine.kt            # WAMR 封装
│       │   └── NativeEngine.kt          # lib*.so 执行
│       ├── cpp/
│       │   ├── wamr/                    # WAMR 源码 (git submodule)
│       │   ├── libvterm/                # 已有
│       │   ├── wasm_bridge.cpp          # WAMR JNI 桥接
│       │   └── vterm_bridge.cpp         # libvterm JNI 桥接
│       └── assets/
│           ├── cpython.wasm             # 预编译 Python WASI
│           ├── clang.wasm               # 预编译 Clang WASI
│           └── quickjs.wasm             # WasmEdge QuickJS (Node.js API 兼容)
└── ios/
    └── (同样的 WAMR + libvterm，通过 FFI)
```

**Module TS 接口**:
```typescript
interface PocketTerminalModule {
  // WASM 引擎执行
  execWasm(runtime: 'python' | 'clang' | 'quickjs', code: string, args?: string[]): Promise<{
    stdout: string; stderr: string; exitCode: number;
  }>;

  // Native 引擎执行 (Android only)
  execNative(command: string, cwd?: string): Promise<{
    stdout: string; stderr: string; exitCode: number;
  }>;

  // 环境管理
  isRuntimeInstalled(runtime: string): Promise<boolean>;
  installRuntime(runtime: string): Promise<void>;

  // PTY (Phase 2)
  openPty(rows: number, cols: number): Promise<string>;
  writePty(sessionId: string, data: string): void;
  resizePty(sessionId: string, rows: number, cols: number): void;
  closePty(sessionId: string): void;
}
```

#### 1.2 LocalExecutor 服务层

**新建** `packages/app/src/services/localExecutor.ts`:
- 语言检测：根据文件扩展名/命令自动路由到 WASM 或 Native 引擎
- `python3 xxx.py` → WASM (cpython) — 双平台
- `gcc xxx.c && ./a.out` → WASM (clang) — 双平台
- `node xxx.js` → WASM (WasmEdge QuickJS，Node.js API 兼容) — 双平台
- `go run xxx.go` → Native lib*.so (Android) / 云端降级 (iOS)

#### 1.3 集成到现有工具链

**修改** `packages/app/src/services/localFileSystem.ts` (L188):
```typescript
case "runCommand":
  return localExecutor.exec(args.command as string, args.cwd as string);
```

**修改** `packages/app/src/store/settings.ts`:
- 增加 `localExecutorEnabled: boolean`

#### 1.4 声明式包管理器

**新建** `packages/app/src/services/packageManager.ts`:
- JSON 清单驱动，从 CDN 下载 .wasm 运行时
- SHA-256 哈希校验防篡改
- 按需下载，不预装

清单格式:
```json
{
  "runtimes": {
    "python": {
      "version": "3.13.1",
      "wasm_url": "https://cdn.example.com/cpython-3.13.1-wasi.wasm.gz",
      "blob_hash": "sha256:abc123...",
      "size_mb": 15,
      "platforms": ["android", "ios"]
    },
    "quickjs": {
      "version": "2024.1",
      "wasm_url": "https://cdn.example.com/wasmedge-quickjs.wasm.gz",
      "blob_hash": "sha256:789abc...",
      "size_mb": 5,
      "platforms": ["android", "ios"]
    }
  }
}
```

### Phase 2: Native 降级通道 (Android)

**目标**: Android 上支持 Go + proot Linux shell（完整 Linux 环境）。

#### 2.1 lib*.so Native 执行

- 将 proot、Go 交叉编译为 ARM64 共享库格式
- 重命名为 `libproot.so`、`libgo.so`
- 放入 APK `jniLibs/arm64-v8a/`
- 安装后自动提取到有执行权限的目录

**扩展** `NativeEngine.kt`:
- 通过 `context.applicationInfo.nativeLibraryDir` 获取 lib 路径
- ProcessBuilder 执行 `libproot.so --rootfs=... /bin/sh -c "command"`

#### 2.2 Alpine rootfs (proot 环境)

- 首次使用时下载 Alpine minirootfs (~4MB)
- 存储在 app internal storage
- proot 通过 ptrace 翻译 syscall，rootfs 内文件不需要 execve 权限

### Phase 3: 终端渲染引擎

**目标**: 交互式终端 UI。

#### 3.1 先用 xterm.js + WebView 快速实现

**新建** `packages/app/src/components/TerminalScreen/`:
- `index.tsx`: WebView 加载内联 xterm.js HTML
- `terminal.html`: xterm.js + fit addon，通过 postMessage 与 RN 通信
- `KeyboardToolbar.tsx`: 特殊键栏（ESC/TAB/CTRL/ALT/方向键）

通信链路: xterm.js → postMessage → RN onMessage → writePty → PTY → proot → shell

#### 3.2 后续迁移到 libvterm + Native Canvas

项目中已有 libvterm 源码在 `modules/pocket-terminal-module/android/src/main/cpp/`。

- 通过 CMake 编译为 JNI 库
- libvterm 解析 VT100/xterm 转义序列 → 维护字符栅格 + 属性矩阵
- Android 端: 自定义 View + Canvas 绘制字符栅格
- 双缓冲 + 脏区域重绘优化

### Phase 4: 打磨与 iOS

- 语言环境管理 UI
- workspace 文件挂载映射
- 终端主题/字体设置
- iOS 上仅 WASM 引擎可用（Python + C + JS）
- 远期: Android AVF/pKVM 虚拟化通道

## 关键文件清单

| 文件 | 操作 | Phase |
|------|------|-------|
| `modules/pocket-terminal-module/expo-module.config.json` | 新建 | 1 |
| `modules/pocket-terminal-module/src/index.ts` | 新建 | 1 |
| `modules/pocket-terminal-module/android/build.gradle.kts` | 新建 | 1 |
| `modules/pocket-terminal-module/android/CMakeLists.txt` | 新建 | 1 |
| `modules/pocket-terminal-module/android/.../PocketTerminalModule.kt` | 新建 | 1 |
| `modules/pocket-terminal-module/android/.../WasmEngine.kt` | 新建 | 1 |
| `modules/pocket-terminal-module/android/src/main/cpp/wasm_bridge.cpp` | 新建 | 1 |
| `src/services/localExecutor.ts` | 新建 | 1 |
| `src/services/packageManager.ts` | 新建 | 1 |
| `src/services/localFileSystem.ts` | 修改 L188 | 1 |
| `src/store/settings.ts` | 修改 | 1 |
| `modules/pocket-terminal-module/android/.../NativeEngine.kt` | 新建 | 2 |
| `src/components/TerminalScreen/index.tsx` | 新建 | 3 |
| `src/components/TerminalScreen/terminal.html` | 新建 | 3 |
| `src/components/TerminalScreen/KeyboardToolbar.tsx` | 新建 | 3 |
| `modules/pocket-terminal-module/android/src/main/cpp/vterm_bridge.cpp` | 新建 | 3.2 |

## 前置依赖

| 依赖 | 来源 | 用途 |
|------|------|------|
| WAMR | https://github.com/bytecodealliance/wasm-micro-runtime | WASM 运行时引擎 |
| cpython.wasm | https://github.com/singlestore-labs/python-wasi | Python WASI 构建 |
| clang.wasm | https://github.com/wapm-packages/clang | C 编译器 WASM |
| quickjs.wasm | https://github.com/second-state/wasmedge-quickjs | Node.js API 兼容 JS 引擎 |
| Polygen | https://github.com/callstackincubator/polygen | RN WASM 集成（备选） |
| proot | https://github.com/termux/proot | 用户态 chroot（重命名为 libproot.so） |
| Expo prebuild | `npx expo prebuild` | 切换到 bare workflow |

## 验证方式

1. **Phase 1**: 发消息 "写一个 Python hello world 并运行" → AI writeFile + runCommand → cpython.wasm 本地执行 → 在聊天中看到输出
2. **Phase 2**: 在 Android 上通过 proot shell 执行 `go run main.go`
3. **Phase 3**: 切到 Terminal Tab → 看到 shell 提示符 → 手动输入命令
4. 真机测试: `npx expo run:android`

## 复杂度与取舍

- **Phase 1 最核心**: WAMR 嵌入 + cpython.wasm 可运行是整个方案的基础验证点
- **Phase 3 可降级**: 终端渲染先用 xterm.js WebView，后续迁移到 libvterm + Canvas
- **iOS 受限**: WASM 层可用（Python/C/JS），Go 和 proot shell 不支持
- **WASM 性能**: WAMR AOT 模式性能接近原生 50-80%，对开发/学习场景足够
