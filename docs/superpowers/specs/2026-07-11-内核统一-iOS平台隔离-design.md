# 业务内核统一(P11)+ iOS 平台隔离 · 设计

日期:2026-07-11
状态:已评审(逐节确认通过)
前置:P10(client-core 收编三副本为正典,`33b02b9` 前已合并)、双模式隧道路由(`33b02b9`)

## 1. 背景与目标

App(RN)侧存在三个「冻结副本」:`serverConnection.ts` / `relayClient.ts` / `chatReducer.ts`,
P10 已将其收编进 `@pocket-code/client-core` 为正典,副本头注释约定「P11 RN 切换消费
client-core 时删除本文件」。同时 iOS 侧本地终端为平台限制(沙箱禁 fork/exec,
`ProcessBuilder` 路径仅 Android 可用),需把 iOS 定位为远端执行子集。

**目标**:两平台(iOS/Android)共享同一套业务内核(连接/reducer/relay,即 client-core),
本地执行按平台分叉 —— Android 保留本地 shell(专属功能),iOS 仅远端模式。

## 2. iOS 支持矩阵(范围界定的核心事实)

`workspaceMode` 三模式(`packages/app/src/store/settings.ts:6`):

| 模式 | 命令在哪跑 | 本机 fork 进程? | iOS |
|---|---|---|---|
| `local` | 本设备(`PocketTerminalModule` → `ProcessBuilder("/system/bin/sh")`) | 是 | ❌ 沙箱禁止 |
| `server`(直连) | 用户自己的机器(Termux/远程 Server),App 连 `toolServerUrl` WS | 否 | ✅ 支持 |
| `relay`(中继) | 开发机 daemon,经公网 relay | 否 | ✅ 支持 |

代码已按此分流:`deviceBackend.ts:42` 注释明确 `workspaceMode !== "local"` 时
`executeTool` 经 `conn.execTool` 走 WS 远端执行。所有 `requireNativeModule` 调用均为
惰性(函数体内,无模块顶层调用),`PocketTerminal` 构造器自带 JSI 缺失降级
(`_core = null` + 空安全方法,`modules/pocket-terminal-module/src/PocketTerminalModule.ts:31-49`)——
iOS 导入这些文件不触发 native,挂载 TerminalScreen 也不崩(只是死终端)。

**结论:iOS 仅隔离 `local` 一种;`server`(用户自备内网穿透/公网直连)与 `relay`
(用户自备 VPS 中继)均完整支持。**

## 3. 决策记录

| # | 决策点 | 结论 |
|---|---|---|
| D1 | iOS 上 local 模式的呈现 | 保留选项但置灰 + 「本地终端仅 Android 支持」提示;不隐藏 |
| D2 | iOS 默认 `workspaceMode` | `relay`(与 Android 现有 relay 体验一致,配对流程现成);`server` 仍可手动选 |
| D3 | 配对 token 持久化职责 | `ConnectionConfig` 加 `onTokenPersist?`,ServerConnection 建 RelayClient 时转发(消除运行时路径持久化黑洞) |
| D4 | 副本删除时机 | 先切引用跑绿,再同一改动删副本及其测试(单 PR 原子) |
| D5 | iOS 本地终端入口 | 导航层 Platform 分叉:iOS 不渲染终端 Tab、不挂载 TerminalScreen;组件代码保留 |
| D6 | relay 获取方式(开源姿态) | 文档路线:开源非开箱即用,用户自备 VPS 为既定前提;不做公共托管/P2P |
| D7 | 本地执行三 service 是否加平台守卫 | 不加(惰性 native + mode 分流天然绕开,YAGNI) |

## 4. A 块 · 业务内核统一(P11)

### A1. client-core 增量(纯增量,不破坏 Web 消费方)

`packages/client-core/src/serverConnection.ts`:

- `ConnectionConfig` 加可选字段:

```ts
export interface ConnectionConfig {
  // …现有字段不变…
  /** 配对成功后由宿主持久化 token(RN: updateSettings 包装;Web: localStorage) */
  onTokenPersist?: (token: string, machineId: string) => void;
}
```

- `connect()` 内建 `RelayClient` 处(现 73–79 行)透传:

```ts
ws = new RelayClient({
  relayUrl: url,
  machineId: relay.machineId,
  deviceId: relay.deviceId,
  deviceName: "Pocket Code App",
  token: relay.token,
  onTokenPersist: this.config.onTokenPersist,   // 新增
});
```

`RelayClientOptions.onTokenPersist` P10 已存在,此处仅把 config → client 的透传接上。

### A2. 删除清单

- 删源文件:`packages/app/src/services/serverConnection.ts`、
  `packages/app/src/services/relayClient.ts`、`packages/app/src/hooks/chatReducer.ts`
- 删测试:`packages/app/src/services/relayClient.test.ts`、
  `packages/app/src/hooks/chatReducer.test.ts`(serverConnection 无 App 侧测试)
- 覆盖不丢:client-core 自带 `serverConnection.test.ts` / `relayClient.test.ts` /
  `chatReducer.test.ts` 即正典覆盖(diff 已证副本与正典逻辑等价:serverConnection
  仅差冻结注释;chatReducer 差注释 + 2 行类型 import 路径;relayClient 差注释 +
  `updateSettings` 直调 → `onTokenPersist` 回调)。

### A3. 引用切换 + 接线(仅 3 个文件)

| 文件 | 改动 |
|---|---|
| `packages/app/src/hooks/useAgent.ts` | ① `ServerConnection`/`ConnectionConfig`/`ConnectionHandlers`(现 L13)、`applyAgentEvent`/`phaseFor`/`truncateCoreHistory`/`storedToCoreMessages`/`Message`/`ImageAttachment`/`ToolCall`(现 L14/15/23)改从 `@pocket-code/client-core` import;② `StreamingPhase`(现 L10/22)改从 client-core(直取真相源);③ `StoredMessage`(现 L8)保持从 `../store/chatHistory`(其已 re-export client-core)或直取 client-core,取直取;④ **接线**:构造 `ConnectionConfig` 处加 `onTokenPersist: (token, machineId) => updateSettings({ relayToken: token, relayMachineId: machineId })` |
| `packages/app/src/services/workspaceSync.ts` | `RelayClient`(现 L9)改从 client-core import;构造处(现 L54)注入同款 `onTokenPersist`(替代原副本内部直调 `updateSettings`) |
| `packages/app/src/components/Settings/SettingsScreen.tsx` | `RelayClient` 改从 client-core import(现 L129 临时配对 client)。**不注入 onTokenPersist** —— 该流程已用 `pairDevice()` 返回值 + `onSave` 显式持久化(L153–157),注入会双写 |

**零改动确认**:`StreamingIndicator/index.tsx` 与 `store/chatHistory.ts` 已从
client-core import 并 re-export 这些类型(P10 已对齐),不需要动。

### A4. 行为等价承诺

- client-core 公共 API 不变(仅加可选字段,向后兼容,Web 端不受影响)。
- relay 配对 token 持久化:副本内部直调 `updateSettings` → 宿主经 `onTokenPersist`
  注入 `updateSettings`,净效果相同。

## 5. B 块 · iOS 平台隔离

### B1. `packages/app/App.tsx` — 终端 Tab 平台分叉(两处)

- Tab 栏按钮(现 L521):`(["chat", "terminal", "files", "preview"] as const)` 按平台
  过滤,iOS 数组不含 `"terminal"`。过滤逻辑提纯为可测纯函数
  `tabsForPlatform(os): Tab[]`(与 §6 测试策略对应)。图标/标签 map 不动。
- 常驻挂载块(现 L382–389):`<KeyboardAvoidingView>…<TerminalScreen />` 整块套
  `Platform.OS === "android" &&`。iOS 不挂载(省死终端 mount + warn 噪音);
  Android 保持常驻保活 PTY。
- `activeTab` 状态类型不变(iOS 永远不会被设为 `"terminal"`)。

### B2. `packages/app/src/store/settings.ts` — 默认模式按平台

- `DEFAULT_SETTINGS.workspaceMode`(现 L88):`"local"` →
  `Platform.OS === "ios" ? "relay" : "local"`。
- 仅影响首次安装/无存档默认;已有存档(`{...DEFAULT_SETTINGS, ...JSON.parse(raw)}`)
  不受影响。Android 语义零变化。

### B3. `packages/app/src/components/Settings/SettingsScreen.tsx` — local 选项 iOS 置灰

- 工作区模式选择区 local 选项(现 L370–381):iOS 上 `disabled` + 置灰样式 +
  副文案「本地终端仅 Android 支持」;`onPress` iOS 不生效。
- `server`/`relay` 选项两平台照常;Android local 选项不变。

### B4. 明确不改(防过度守卫)

- `localExecutor` / `runtimeManager` / `processManager` / `deviceBackend` /
  `localFileSystem`:零改动(native 全惰性、`local` 分支 iOS 不可达、构造器已降级)。
- `FilesTab` / `PreviewTab` / `useAgent` 的 mode 分支:零改动(`isLocal` 在 iOS 恒
  false,自然走远端)。
- `pocket-terminal-module` iOS Swift stub:保持现状(存在即保证 pod 链接通过;
  不实现真功能)。

### B5. 文档(D6 落地)

- 仓根 `README.md`(及 App 相关文档):iOS 支持矩阵 —— `server`(直连,用户自备
  内网穿透/公网)与 `relay`(中继,用户自备 VPS)可用;`local` 本地 shell 为
  **Android 专属**(iOS 沙箱禁 fork/exec,平台限制而非工程缺口);部署指引指向
  `docs/deployment-relay-daemon.md`。

## 6. 测试策略

- **A 块**:`pnpm test:all` 全绿为门槛;client-core 三测试文件即正典覆盖,删除的
  App 侧 2 个测试不补(重复覆盖)。client-core `serverConnection.test.ts` 补一个
  用例:config 提供 `onTokenPersist` → 构造出的 RelayClient 收到该回调(透传断言)。
- **B 块**:settings 默认值按平台 —— jest Platform mock 各断言一次(ios → relay,
  android → local);Tab 过滤提纯为 `tabsForPlatform(os)` 纯函数并单测;
  SettingsScreen 置灰为 UI 表现,人工验收。

## 7. 执行顺序(单分支,A 先 B 后)

1. client-core 加 `onTokenPersist` 透传(+ 测试)。
2. App 三处切 import + 接线 → `test:all` 绿 → 同一改动删 3 副本 + 2 测试 → 再绿。
3. B 块三改(App.tsx / settings.ts / SettingsScreen)+ 测试。
4. 文档(B5)。

依据:A 是纯重构,绿了再叠 B 的行为分叉,出问题好定位。

## 8. 验收标准

- `pnpm test:all` 全绿(A 步与 B 步各自绿一次)。
- `packages/app/src` 不再存在三副本;全仓 grep 无指向旧相对路径
  (`../services/serverConnection`、`./relayClient`、`./chatReducer` 等)的 import。
- Android 行为零变化:默认仍 `local`、终端 Tab 仍在、relay 配对/token 持久化行为等价。
- iOS(代码级验收):Tab 栏无 terminal、TerminalScreen 不挂载、默认
  `workspaceMode === "relay"`、Settings 中 local 置灰带提示、`server`/`relay` 可选可配。
- 真机验收(后置,非合并阻塞):EAS 云构建 iOS 包,relay 模式配对 → 聊天/文件/预览
  可用。与「子域模式真机验收」同列 backlog。

## 9. 风险与回滚

- 最大风险在 A3 接线:`onTokenPersist` 注入遗漏 → relay 配对后 token 不落盘,重启掉
  配对。防线:client-core 透传测试 + SettingsScreen 显式持久化路径独立(双保险)。
- B 块风险极低(三处 UI/默认值分叉,不触碰 Android 路径)。
- 回滚:分支未合并直接弃;合并后 revert 原子恢复副本时代(删除与切换同 PR)。

## 10. 范围外

公共 relay 托管、P2P/无 relay 直连、iOS WASM 本地能力(esbuild-wasm 离线预览,
独立 backlog)、Android 任何行为改变、A 层(C++ vterm 渲染核)与 B 层
(ProcessBuilder 进程孵化)的任何改动。
