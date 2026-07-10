# Relay 拆分：protocol-core 拆层 + tunnel-client + 发布就绪与安全加固 设计

> 日期：2026-07-10
> 状态：已与用户确认（范围 relay；仓内拆层+发布就绪；轻通用化+两项安全加固；tunnel-client 纳入；方案 A；MIT）
>
> 一句话定位：**wire 拆出 `@pocket-code/protocol-core`（信封/配对/隧道/边界 union，payload 放宽），relay 只依赖它；从 daemon 抽出 `@pocket-code/tunnel-client`（注册/心跳/隧道帧转发 + 最小 CLI），daemon 复用；relay 补发布就绪件与两项安全加固（RELAY_DISCOVERY 开关、TUNNEL_TOKEN 可选隧道鉴权）——relay+tunnel-client 构成可独立部署的"设备配对+消息中继+HTTP/WS 反向隧道"服务，仍留 monorepo，随时可迁。**

## 0. 决策记录

| 决策点 | 结论 | 理由 |
|---|---|---|
| 本轮范围 | relay（拆分路线候选一） | 用户指定 |
| 拆分形态 | 仓内拆层+发布就绪，不迁 repo | 保留原子提交迭代速度；真要公开时 git subtree 一天内可迁 |
| 通用化程度 | 轻通用化（协议与默认值保持现状）+ 两项安全加固 | 不碰运行中的协议；独立隧道服务的安全故事必须站得住 |
| tunnel-client | 纳入本轮 | relay 只是隧道的公网汇聚端；配上独立客户端才是完整"类 ngrok"产品 |
| wire 拆层方式 | 方案 A：新建 protocol-core，wire 降级为聚合层原样 re-export | app/server/daemon 导入路径零改动 |
| License | MIT（仓库根 LICENSE，三包 package.json 标注，保持 private:true） | 发布就绪但不发布 |

## 1. 背景与现状（已验证）

- relay 对 wire 的非测试导入仅 1 处：`messageRouter.ts` 的 `RelayInbound`。外部依赖仅 ws/zod/dotenv。业务耦合点：`RelayRequest.payload: WsMessage`（P9 spec 候选一预案已指出）。
- daemon 结构利于抽取：`connection.ts`（注册/HMAC/心跳）、`tunnel.ts`（HTTP 代理+WS 隧道，仅依赖 ws）、`inbound.ts`（DaemonInbound 解析）是纯协议层；`pairing.ts`（设备 JWT）与 `index.ts`（接 server messageHandler）是业务层，不动。
- machineId：`m_` + 8 随机字节（64 位熵），持久化于 `~/.pocket-code/machine-id`（0600）。
- 隧道入口（`/t/<machineId>/<port>/` 与 `pc_tunnel` cookie）**无鉴权**——machineId 即能力凭证；且 `list-machines` 对任意 relay WS 连接可见（plan.md 安全后置第 1 项），构成泄漏放大器。本设计第 4 节针对性加固。

## 2. protocol-core 拆层（方案 A）

**新包 `packages/protocol-core`**（zod 唯一运行时依赖；tsc + vitest + TS strict，模板同 agent-core）。从 wire **迁移**（非复制）四类 schema 及对应测试：

| 类别 | 符号 | 原文件 |
|---|---|---|
| 信封 | RelayRequest / ForwardRequest / ForwardResponse / RelayResponse / ForwardStream / RelayStream | relay.ts |
| 配对与发现 | PairRequest / PairResponseSuccess / PairResponseError / PairResponse / DaemonRegister / DaemonHeartbeat / ListMachines / MachineInfo / ListMachinesResponse | pairing.ts |
| 隧道帧 | TunnelRequest / TunnelResponse / TunnelChunk / TunnelEnd / TunnelWsOpen / TunnelWsOpened / TunnelWsData / TunnelWsClose / TunnelFrame | tunnel.ts |
| 边界 union | RelayErrorMessage / DaemonRegistered / RelayInbound / DaemonInbound | inbound.ts |

**唯一语义变更**：`RelayRequest.payload` 与 `ForwardRequest.payload` 从 `WsMessage` 放宽为 `z.record(z.unknown())`——中继从此不认识业务协议。业务校验兜底不变（daemon messageHandler 对 payload 做业务 safeParse，P6a 既有行为）。

**wire 降级为聚合层**：依赖 protocol-core 并原样 re-export 全部迁移符号，保留自有业务层（WsMessage/ServerOutbound/AgentEvent）——app/server/daemon 导入路径零改动。

**relay 切换**：`messageRouter.ts` 导入改 `@pocket-code/protocol-core`；package.json 移除 wire。此后 relay 依赖图 = protocol-core + ws + dotenv + zod，可独立构建部署。

## 3. tunnel-client 抽取

**新包 `packages/tunnel-client`**（依赖 protocol-core + ws；CLI 另用 dotenv）。从 daemon **迁移**（非复制，daemon 同轮切换复用，不留副本——同仓原子提交，无 P10 双副本理由）：

- `connection.ts` → `RelayConnection`：ws 生命周期、HMAC 注册（RELAY_SECRET）、心跳、重连、`parseRelayMessage`（用 protocol-core 的 DaemonInbound）。
- `tunnel.ts` → `proxyToLocalhost` / `openLocalWebSocket` / `onWsTunnelData` / `onWsTunnelClose` / `closeAllWsTunnels`。
- **可插拔边界**：注册/心跳/隧道帧包内自消化；非隧道消息（forward-request / pair-request）经 `onMessage` 回调向外委托——daemon 把 pairing 与 messageHandler 插入；独立 CLI 模式对此类消息回错误帧并记日志。
- **最小 CLI**（bin：`pocket-tunnel`）：`--relay wss://host/relay --secret xxx --name my-machine`（env 兜底：RELAY_URL/RELAY_SECRET/MACHINE_NAME）；machineId 首次生成后持久化到 `~/.pocket-tunnel.json`（对齐 daemon 身份持久化模式）。
- **daemon 复用**：删除自身 connection.ts/tunnel.ts（及 inbound.ts 中随迁部分），改从 tunnel-client 导入；pairing.ts 与 index.ts 业务编排不动；daemon 测试保持绿，tunnel/connection 测试随迁 tunnel-client。

## 4. 安全加固（两项，默认值均保持现状）

威胁模型分层：端点注册（RELAY_SECRET HMAC + P6a 身份绑定，强）／传输（wss 靠 nginx，部署文档约定）／浏览器侧隧道入口（machineId 即凭证，弱——本节加固）。

**4.1 `RELAY_DISCOVERY`（默认 `on`）**：设为 `off` 时，relay 对 `list-machines` 回 error、拒绝转发 `pair-request`（回 pair-response 失败）。纯隧道部署不需要发现与配对，堵住"任意 WS 连接枚举在线 machineId"的泄漏放大器。pocket-code 自用部署保持 on，行为不变。

**4.2 `TUNNEL_TOKEN`（默认空=关闭）**：设置后隧道入口强制鉴权：
- 显式路径首次请求需带查询参数：`/t/<machineId>/<port>/?pc_token=<TUNNEL_TOKEN>`；校验通过才建隧道，并 `Set-Cookie: pc_tunnel_token=<值>; Path=/; HttpOnly; SameSite=Lax`。
- 后续绝对路径子资源与 WS upgrade 走 `pc_tunnel_token` cookie 校验（与既有 `pc_tunnel` 路由 cookie 并行）。
- 校验失败一律 404（不区分"不存在"与"未授权"，不给探测信号）。
- 效果：machineId 从唯一能力凭证降级为路由标识。

README 安全模型一节写透：单租户共享密钥设计、machineId 视为能力凭证（未开 TUNNEL_TOKEN 时）、建议 wss + TUNNEL_TOKEN、已知后置项（per-machine TOFU、多租户隔离、referrer 泄漏注意）。

## 5. 发布就绪件（轻通用化）

- `packages/relay/README.md`：定位（设备配对+消息中继+HTTP/WS 反向隧道）、架构图、协议概览（指向 protocol-core）、独立部署指南（从 `docs/deployment-relay-daemon.md` 提取 relay 部分并交叉引用）、安全模型（第 4 节内容）、与 tunnel-client 的 quickstart。
- `packages/tunnel-client/README.md`：CLI 用法与最小示例。
- 仓库根 `LICENSE`（MIT）；relay/protocol-core/tunnel-client 三包 package.json 补 license/description/repository/keywords，保持 `private: true`。
- 协议与默认值不动：`/relay` 控制路径、`pc_tunnel` cookie 名、心跳间隔等保持现值。

## 6. 测试与验收

- protocol-core：wire 对应 schema 测试随迁；新增"任意对象 payload 通过信封校验"锁定测试。
- 存量不回归：relay 57 例（导入切换后）、daemon 剩余测试、wire 剩余测试全绿。
- 安全加固测试：DISCOVERY off 下 list-machines/pair-request 被拒；TUNNEL_TOKEN 开启后无 token 404、带 token 建隧道并种 cookie、cookie 路径与 WS upgrade 校验通过/失败两侧。
- **端到端自动化烟测**（验收核心，证明"不装 daemon 也能做隧道代理"）：本地起 relay + tunnel-client CLI 指向本地 http 测试服务，curl 经 `/t/<id>/<port>/` 穿透取回响应；TUNNEL_TOKEN 开启版再跑一遍（无 token 404 / 带 token 通）。
- 全仓门禁：`pnpm build && pnpm test:all && pnpm typecheck:app`（test:all 纳入两个新包）。

## 7. 非目标

- npm 实际发布、迁出独立 repo。
- 路径/cookie 名/心跳间隔可配置化。
- pairing 通用化（留 daemon）。
- tunnel-client 多 relay 高可用、TLS 内建（继续靠 nginx）。
- per-machine TOFU、多租户隔离（安全后置清单不变）。

## 8. 与拆分路线的关系

- 本轮完成后，拆分路线候选一（relay）达到"随时可迁"终态：依赖图自足（protocol-core+ws）、发布件齐、安全故事完整；真正开源时仅剩 git subtree 迁移 + npm 发布两个机械步骤。
- 候选二（cli 适配层）仍在拆分路线待办中，价值最高，可作为下一轮。
- P11（RN 切 client-core）不受影响，待办顺序由用户定。
