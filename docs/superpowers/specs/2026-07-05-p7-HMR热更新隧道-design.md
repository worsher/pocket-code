# P7 HMR 热更新隧道 设计

> 日期：2026-07-05
> 状态：已与用户确认（方案 B：ws 库消息级转发；仅 relay 模式）
> 上游：`2026-06-02-pocket-code-重构设计.md` §5.2（"MVP 先做整页刷新预览（纯 HTTP 隧道）；HMR（WS upgrade 隧道）后置"）——本设计即该后置项。
> 一句话定位：**让中继预览支持 WebSocket upgrade，vite/next dev server 的 HMR 在手机 WebView 里生效（现在只能整页刷新）。**

---

## 1. 背景与现状

P5 的中继 HTTP 隧道已跑通：手机 WebView → relay `/t/<machineId>/<port>/*`（或 `pc_tunnel` cookie 路由绝对路径）→ `tunnel-request` 帧 → daemon `proxyToLocalhost`（fetch `127.0.0.1:<port>`）→ `tunnel-response/chunk/end` 帧流式回传。P6a 给隧道帧加了归属校验（`TunnelHub.owned` + `abortByMachine`）。

缺口：dev server 的 HMR 走 WebSocket——vite client 连 `ws://<location.host>/`（默认路径 `/`，握手自带 cookie），next 连同源 `/_next/webpack-hmr`。当前 relay 对 WS upgrade 的处理是 `new WebSocketServer({ server: httpServer })`（`relay/src/index.ts:113`），**吃掉所有 upgrade**：隧道路径的 WS 握手会被当成控制连接处理（进 `messageRouter` 然后因非法消息被拒），HMR 必然失败，WebView 里只能整页刷新看效果。

## 2. 目标与非目标

### 2.1 目标

1. relay 模式下，手机 WebView 打开隧道预览页后，页面内发起的 WebSocket（vite HMR `/`、next `/_next/webpack-hmr`）经 relay↔daemon 隧道透传到开发机 `localhost:<port>`，改文件手机即时热更新。
2. upgrade 路由拆分后，App/daemon 的**控制 WS 连接行为完全不变**。
3. WS 隧道纳入 P6a 的安全模型：帧带归属 machineId 校验，daemon 掉线只中止该机的 WS 隧道。
4. App 零改动（WebView 内的 dev-server client 自主发起 WS）。

### 2.2 非目标（明确后置）

- 局域网直连模式：手机直连 `http://机器IP:端口`，HMR 天然可用，不经隧道。
- 原始字节级透传（方案 A）：对任意非 ws 库可握手的子协议才需要，HMR 场景无收益。
- App→relay 连接鉴权、隧道访问控制：沿用现状（P6a 已知后置项，本期不扩大也不收窄）。
- HTTP 隧道行为：`tunnel-request/response/chunk/end` 链路不动。

## 3. 设计

### 3.1 wire：WS 隧道帧（`packages/wire/src/tunnel.ts` 扩充）

| 帧 | 方向 | 载荷 |
|---|---|---|
| `tunnel-ws-open` | relay→daemon | `{ tunnelId, port, path, headers }`——headers 只透传白名单：`cookie`、`sec-websocket-protocol`、`user-agent`、`origin`（origin 重写为 `http://127.0.0.1:<port>`，规避 dev server 的 origin 校验） |
| `tunnel-ws-opened` | daemon→relay | `{ tunnelId, protocol? }`——本地连接成功，protocol 为协商出的子协议 |
| `tunnel-ws-data` | 双向 | `{ tunnelId, data, binary? }`——文本消息 data 直传字符串；二进制消息 `binary: true` 且 data 为 base64 |
| `tunnel-ws-close` | 双向 | `{ tunnelId, code?, reason? }`——任一侧关闭/出错都发此帧，对端随之关闭 |

- `tunnelId` 由 relay 生成（`ws_` 前缀 + randomUUID，与 HTTP 隧道的 id 空间区分）。
- 全部帧进 `TunnelFrame` 联合；`RelayInbound`/`DaemonInbound`（P6a 的边界联合）同步扩充对应方向的成员。
- 关闭码透传但夹紧到合法范围（1000-4999，非法值落 1000），避免 ws 库抛异常。

### 3.2 relay：upgrade 路由拆分 + wsTunnelHub

**upgrade 路由**（`index.ts`）：
- 控制 WSS 改 `new WebSocketServer({ noServer: true })`；`httpServer.on("upgrade", ...)` 手动分流：
  1. 路径匹配 `/t/<machineId>/<port>/<rest>` → WS 隧道（显式路径）。
  2. 否则请求头 cookie 含 `pc_tunnel=<machineId>:<port>` → WS 隧道（绝对路径，vite 连 `/` 走这里）。
  3. 其余 → `wss.handleUpgrade(...)` 交控制通道（App/daemon 现行为不变）。

**`wsTunnelHub.ts`（新，镜像 `TunnelHub` 的模式）**：
- `open(tunnelId, browserWs, machineId)`：登记浏览器侧 ws 与归属。
- `onOpened/onData/onClose(tunnelId, ..., senderMachineId?)`：归属校验（不符丢弃 + warn，沿用 P6a 语义），data 帧写回浏览器 ws（binary 时 `Buffer.from(data, "base64")`）。
- 浏览器侧 ws 的 message/close → 经 `sendRawToDaemon` 发对应帧给 daemon。
- `abortByMachine(machineId)`：daemon 掉线时关闭该机全部 WS 隧道（close 1001）。
- 握手时序：收到 upgrade **先完成与浏览器的 ws 握手**（`ws` 库需在 upgrade 事件同步 handleUpgrade），再发 `tunnel-ws-open`；`tunnel-ws-opened` 到达前浏览器侧来的消息缓冲（数组上限 64 条，超限关闭隧道）；daemon 回 `tunnel-ws-close`（本地连接失败）则关浏览器 ws（1011）。
- 子协议：浏览器请求的 `sec-websocket-protocol` 透传给 daemon；但对浏览器的握手须**同步**选定协议——采取"回显首个请求协议"策略（vite 用 `vite-hmr`/无协议，next 无协议，回显即正确；与 daemon 实际协商结果不一致的极端情况由 close 兜底）。

**`messageRouter.ts`**：新增三个 daemon 回帧 case（`tunnel-ws-opened/data/close`），role/machineId 检查与现有 tunnel 帧一致，转 `wsTunnelHub`。

### 3.3 daemon：本地 WS 客户端

**`tunnel.ts` 新增 `openLocalWebSocket(frame, send): void`**：
- `new WebSocket("ws://127.0.0.1:<port><path>", protocols, { headers })`（`ws` 库 client；protocols 从帧 headers 的 `sec-websocket-protocol` 拆分）。
- `open` → 发 `tunnel-ws-opened`；`message` → 发 `tunnel-ws-data`（Buffer→base64+binary，string 直传）；`close`/`error` → 发 `tunnel-ws-close`。
- 维护模块级 `Map<tunnelId, WebSocket>`；收到 relay 来的 `tunnel-ws-data/close` 按 id 转发/关闭；relay 断连时（`onDisconnected`）全部关闭。

**`index.ts`**：`handleRelayMessage` 加 `tunnel-ws-open/data/close` 三个 case（`DaemonInbound` 联合已在 wire 扩）。

### 3.4 生命周期与清理

- 浏览器关页/WebView 销毁 → 浏览器侧 close → 帧到 daemon → 本地 ws 关闭。
- dev server 重启 → 本地 ws close → 帧到 relay → 浏览器 ws 关闭 →（vite client 自带重连，会重新走 upgrade 建新隧道）。
- daemon 掉线 → relay `abortByMachine`（HTTP 与 WS 隧道都关）。
- 空闲超时：**不做**——HMR 连接本就长寿命且 ws 有协议级 ping/pong，误杀成本高于收益（与控制连接的心跳机制互不相干）。

## 4. 测试策略

- **wire**：新帧正/负样例 + 两个边界联合的扩充用例。
- **daemon 单测**：本地起真实 `ws` server，`openLocalWebSocket` 全链路——open→opened 帧、文本/二进制双向 data、server 主动关闭→close 帧、连接失败（端口无服务）→close 帧；relay 侧 data/close 入帧的转发。
- **relay 单测**：upgrade 路由三分流（显式路径/cookie/控制通道——mock socket 验证各自走到对应处理器）；`wsTunnelHub` 归属校验（伪 machineId 的 data/close 帧丢弃）、缓冲上限、`abortByMachine` 只关本机。
- **集成测试**（relay 包内）：真实 http server + 真实 ws——浏览器侧 ws client ↔ relay ↔ 模拟 daemon（直接注入帧）往返一条消息。
- **真机验收**：relay 模式打开 vite 项目预览 → 开发机改一个组件文件 → 手机 WebView 不刷新即更新；next 项目同验。

## 5. 验收标准

1. `pnpm build && pnpm test:all` 全绿。
2. 控制通道回归：App 配对/对话/同步、daemon 注册心跳在 upgrade 路由拆分后行为不变（现有 relay 测试全过 + 真机回归）。
3. 真机：vite dev server 经中继隧道 HMR 生效（改文件手机即时热更、无整页刷新）；关闭 dev server 后 vite client 能自动重连恢复。
4. 伪造 machineId 的 WS 隧道回帧被丢弃（测试证明）。

## 6. 风险与缓解

| 风险 | 缓解 |
|---|---|
| vite 的 HMR ws 连到 `ws://relay-host/`（无 /t 前缀），依赖 cookie 路由 | P5 已给预览页下发 `pc_tunnel` cookie 且浏览器 WS 握手自带 cookie；真机验收覆盖此路径。若个别 WebView 不带 cookie，fallback 是文档指导用户在 vite config 设 `server.hmr.path`（不进代码） |
| nginx 反代需支持隧道路径的 WS upgrade | 部署文档更新：`location /` 已有 `Upgrade` 头配置（P5 配置本就含），确认 `/t/` location 块也加 upgrade 三件套 |
| 子协议同步回显与 daemon 实际协商不一致 | vite/next 场景不会触发；极端情况 close 兜底断开，client 重连 |
| wss 改 noServer 影响控制通道 | 现有 relay 测试直接驱动 messageRouter 不受影响；集成层真机回归验证 |
