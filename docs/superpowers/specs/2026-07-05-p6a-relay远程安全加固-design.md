# P6a Relay 远程模式安全加固 设计

> 日期：2026-07-05
> 状态：已与用户确认（注册门槛选定"强制 RELAY_SECRET"）
> 上游：`2026-06-02-pocket-code-重构设计.md` 第 8 节「MVP 远程模式加固」的收尾。
> 一句话定位：**关掉 relay 中继链路上的两个真实安全洞（匿名注册顶替、跨 daemon 响应伪造），并让 daemon/relay 消息边界用 wire schema 校验。**

---

## 1. 背景与现状

重构 P1–P5 已完成，relay 链路功能可用，但 spec §8 列出的远程加固项只做了一部分：

**已做：**
- relay `requestMap` 泄漏已修（`RequestTracker` + TTL，commit 59f2475）。
- daemon 校验 device token，拒绝时回 `Unauthorized`；App 收到后停止重连并提示重新配对。
- relay 已有**可选的** `RELAY_SECRET` HMAC 注册验证（`HMAC-SHA256(machineId + timestamp, RELAY_SECRET)`，含 5 分钟时间窗防重放 + `timingSafeEqual`）。

**未做（本设计范围）：**

1. **匿名注册顶替**：`RELAY_SECRET` 未设置时（默认），任何连接可用任意 machineId 注册，且直接**顶掉在线 daemon**（`relay.ts` registerDaemon "Replacing existing daemon connection"），后续 App 流量全部流向冒名者。
2. **跨 daemon 响应伪造**：`forward-response` / `forward-stream` / `tunnel-response|chunk|end` 只检查发送者 `role === "daemon"`，不检查**是不是该请求所属的 daemon**——已注册的恶意 daemon 可用他人 requestId/tunnelId 劫持响应流。`daemon-heartbeat` 同理可刷任意 machineId 的心跳。
3. **边界无 schema 校验**：relay（`index.ts:137`）与 daemon（`connection.ts:106` → `handleRelayMessage`）都是裸 `JSON.parse` + 手工字段检查。wire 里 `DaemonRegister` / `DaemonHeartbeat` / `ForwardResponse` / `TunnelFrame` / `PairRequest` 等 schema **早已定义齐全但边界上无人使用**。

## 2. 目标与非目标

### 2.1 目标

1. relay 注册**强制鉴权**：无 `RELAY_SECRET` 不启动（fail fast），彻底关掉匿名顶替。
2. **响应身份绑定**：requestId / tunnelId / heartbeat 与其归属 machineId 绑定，回帧校验发送者身份。
3. daemon/relay 消息边界统一 `safeParse`（wire 单一真相源落到实处），非法消息拒收 + 日志，不 crash。
4. App 发出的消息格式**零变化**，App 代码零改动。

### 2.2 非目标（明确后置）

- App→relay 连接本身的鉴权：`list-machines` 对任何连接可见（只泄露机器名/在线状态；配对仍需 8 位配对码，业务请求仍需 device token）。后续可加。
- wss/TLS：仍由部署层（nginx 终止 TLS）负责，代码不强制，部署文档已有说明。
- per-daemon TOFU 指纹（不依赖共享密钥的内部冒名防护）：个人部署场景下所有 daemon 同属一人，共享密钥足够；多租户时再做。

## 3. 设计

### 3.1 注册强制鉴权（relay + daemon 对称 fail-fast）

- **relay 启动时**：`RELAY_SECRET` 未设置或为空 → `console.error` 打印错误与生成指引（`openssl rand -hex 32`），`process.exit(1)`。
- **daemon 启动时**：同样强制 `RELAY_SECRET`（否则注册必被 relay 拒绝，与其静默重试刷屏不如早失败）；错误信息说明需与 relay 侧一致。
- 现有 HMAC 验证逻辑（时间窗 + timingSafeEqual）保持不动；`daemon-register` 消息里 `authToken`/`timestamp` 从可选变为**语义上必带**（schema 仍可 optional，relay 逻辑必检——因 RELAY_SECRET 恒存在，原"未配置则跳过验证"分支删除）。
- 同 machineId 重连顶掉旧连接的行为**保留**：有强制鉴权后，这是 daemon 重启/网络切换后恢复的正常路径。
- `docs/deployment-relay-daemon.md` 更新：RELAY_SECRET 从可选改为必填。

### 3.2 响应身份绑定（relay）

- `RequestTracker`：`track(requestId, appSocket)` → `track(requestId, appSocket, machineId)`，内部记录 `requestId → { socket, machineId, expiresAt }`。
  - `forward-response` / `forward-stream` 处理时，用发送 socket 已注册的 machineId（连接闭包变量，注册时赋值）与 tracked machineId 比对，不匹配 → 丢弃 + `console.warn`。
- `TunnelHub`：`open(tunnelId, res, extraHeaders)` → 增加归属 `machineId` 参数；`onResponse` / `onChunk` / `onEnd` 增加 `senderMachineId` 参数校验归属，不匹配 → 丢弃 + 日志。
  - 顺带修 TODO：daemon 掉线时从 `abortAll()`（中止所有隧道）改为 `abortByMachine(machineId)`（只中止该 daemon 的隧道）。
- `daemon-heartbeat`：只接受 `msg.machineId === 该 socket 注册的 machineId`，否则忽略。
- `pair-response` 现已用 socket 自身 machineId 转发（`forwardPairResponse(machineId, msg)`），无需改。

### 3.3 边界 wire safeParse

- **wire 新增**（`packages/wire/src/relayInbound.ts` 或并入现有文件）：
  - `RelayErrorMessage`：`{ type: "error", error: string }`（relay→daemon / relay→app 通用错误，现无 schema）。
  - `DaemonRegistered`：`{ type: "daemon-registered", machineId: string }`（现无 schema）。
  - `RelayInbound` discriminatedUnion（relay 收到的一切）：`DaemonRegister | DaemonHeartbeat | ForwardResponse | ForwardStream | PairResponse* | TunnelResponse | TunnelChunk | TunnelEnd | ListMachines | PairRequest | RelayRequest`。
  - `DaemonInbound` discriminatedUnion（daemon 收到的一切）：`DaemonRegistered | PairRequest（转发，含 relay 附加字段） | ForwardRequest | TunnelRequest | RelayErrorMessage`。
  - \* 注：`PairResponse` 判别键是 `success` 而非 `type`，进不了按 `type` 判别的 discriminatedUnion。**定案**：`RelayInbound` / `DaemonInbound` 用 `z.union([...])`（成员本身各有 `type` 字面量，union 照常工作，只是少了 discriminatedUnion 的错误信息优化——对边界校验足够）。
- **relay**：`JSON.parse` 后 `RelayInbound.safeParse`，失败 → 回 `{type:"error"}` + 日志（消息体截断打印），不进 switch；switch 各分支改用校验后的类型，删除手工 `if (!msg.xxx)` 检查。
- **daemon**：`handleRelayMessage` 入口 `DaemonInbound.safeParse`，失败 → `console.warn` 丢弃，不 crash。

### 3.4 出错行为约定

- relay 对无效注册 / 非法消息：回 `{type:"error", error:...}` 后**不断连**（与现状一致，避免 daemon 端无限重连风暴；HMAC 失败属例外，回错误后由 daemon 自行退避）。
- 身份不匹配的回帧（伪造 requestId/tunnelId/heartbeat）：**静默丢弃 + console.warn**，不回执（不给攻击者探测反馈）。

## 4. 测试策略

- **relay 集成测试**（现有 `relay.test.ts` / `tunnelHub.test.ts` / `requestTracker.test.ts` 扩展）：
  - 无 authToken / 错误 authToken / 过期 timestamp 注册 → 被拒。
  - 恶意 daemon B 用 daemon A 的 requestId 发 `forward-response`/`forward-stream` → 不转发给 App。
  - 恶意 daemon B 发 A 的 tunnelId 回帧 → 被丢弃；A 掉线只中止 A 的隧道，B 的隧道存活。
  - 伪 machineId 心跳 → 不刷新 A 的 lastSeen。
  - 非法 JSON / 未知 type / 缺字段消息 → 拒收且进程不 crash。
- **daemon 单测**：畸形 relay 消息（非法 JSON、未知 type、缺字段的 forward-request/tunnel-request）→ 安全忽略。
- **wire 单测**：`RelayInbound` / `DaemonInbound` 往返（合法样例逐 type 通过、非法样例拒绝）。
- 启动 fail-fast 逻辑抽成可测函数（如 `assertRelaySecret(env)`），单测断言抛错/通过。

## 5. 验收标准

1. `pnpm build && pnpm test:all` 全绿。
2. 未设 `RELAY_SECRET` 启动 relay / daemon → 立即退出并打印含生成指引的错误。
3. 集成测试证明：伪造注册、伪造 requestId/tunnelId/heartbeat 全部被拒。
4. 真机回归：设好 RELAY_SECRET 后，配对 → 发消息 → 流式响应 → 隧道预览全链路与改动前行为一致。
