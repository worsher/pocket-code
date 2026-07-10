# Relay 拆分（protocol-core + tunnel-client + 发布就绪与安全加固）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** wire 拆出零业务依赖的 `@pocket-code/protocol-core`，relay 只依赖它并补齐 RELAY_DISCOVERY/TUNNEL_TOKEN 安全加固与发布件；从 daemon 抽出 `@pocket-code/tunnel-client`（注册/心跳/隧道帧 + 最小 CLI），daemon 复用——relay+tunnel-client 构成可独立部署的"类 ngrok"服务，仍留 monorepo。

**Architecture:** 方案 A——protocol-core 承载信封/配对/隧道/边界 union（`payload` 放宽为 `z.record(z.unknown())`），wire 降级为聚合层原样 re-export（app/server/daemon 导入零改动）。tunnel-client 以 `startTunnelClient(opts)` 为核心（隧道帧自消化、非隧道消息经 `onMessage` 委托），CLI 是其薄封装；daemon 删除自有副本改为消费（同仓原子切换，无冻结副本）。

**Tech Stack:** TypeScript strict / tsc 构建 / vitest；zod schema；ws；node:http。

**Spec:** `docs/superpowers/specs/2026-07-10-relay拆分-protocol-core-tunnel-client-design.md`

## Global Constraints

- protocol-core 运行时依赖仅 zod；tunnel-client 运行时依赖仅 `@pocket-code/protocol-core` + ws + dotenv；不得引入 app/server 业务包。
- 迁移即移动（删源+建新），不留冻结副本；除计划明示的改动（payload 放宽、import 路径、日志前缀 `[Daemon]`→`[Tunnel]`）外逐字一致。
- wire 对外导出面不变：所有原符号继续可从 `@pocket-code/wire` 导入（聚合 re-export），app/server/daemon 源码零改动（Task 7 daemon 切换除外）。
- 协议与默认值不动：`/relay` 控制路径、`pc_tunnel` cookie、心跳 20s、`daemon-register` HMAC 格式保持现状。`RELAY_DISCOVERY` 默认 on、`TUNNEL_TOKEN` 默认关闭——默认行为与现状完全一致。
- 三个新/改包保持 `"private": true`（发布就绪但不发布）；License MIT。
- 每个 task 结束跑其包测试；Task 2、7、11 额外跑全仓门禁 `pnpm build && pnpm test:all && pnpm typecheck:app`（注意先 build：跨包 dist 解析）。
- 提交信息遵循仓库惯例（`feat(protocol-core): ...` 等中文摘要）。

---

### Task 1: protocol-core 包（schema 迁移 + payload 放宽 + 测试）

**Files:**
- Create: `packages/protocol-core/package.json`、`packages/protocol-core/tsconfig.json`
- Create: `packages/protocol-core/src/envelope.ts`（源自 `packages/wire/src/relay.ts`，payload 放宽）
- Create: `packages/protocol-core/src/pairing.ts`（复制 `packages/wire/src/pairing.ts`，零改动）
- Create: `packages/protocol-core/src/tunnel.ts`（复制 `packages/wire/src/tunnel.ts`，零改动）
- Create: `packages/protocol-core/src/inbound.ts`（复制 `packages/wire/src/inbound.ts`，仅 import 路径改动）
- Create: `packages/protocol-core/src/index.ts`
- Create: `packages/protocol-core/src/envelope.test.ts`（新增，放宽锁定）
- Create: `packages/protocol-core/src/inbound.test.ts`（复制 `packages/wire/src/inbound.test.ts`，1 处断言翻转）
- Create: `packages/protocol-core/src/tunnel.test.ts`（复制 `packages/wire/src/tunnel.test.ts`，零改动）
- Modify: 根 `package.json`（test:all 在 `--filter @pocket-code/wire` 后追加 `--filter @pocket-code/protocol-core`）

**Interfaces:**
- Produces: `@pocket-code/protocol-core` 导出——信封 6 个（RelayRequest/ForwardRequest/ForwardResponse/RelayResponse/ForwardStream/RelayStream 及 *Type）、配对 9 个（PairRequest/PairResponseSuccess/PairResponseError/PairResponse/DaemonRegister/DaemonHeartbeat/ListMachines/MachineInfo/ListMachinesResponse 及 *Type）、隧道 9 个（TunnelRequest/TunnelResponse/TunnelChunk/TunnelEnd/TunnelWsOpen/TunnelWsOpened/TunnelWsData/TunnelWsClose/TunnelFrame 及 *Type）、边界 4 个（RelayErrorMessage/DaemonRegistered/RelayInbound/DaemonInbound 及 *Type）。`RelayRequest.payload` 与 `ForwardRequest.payload` 为 `z.record(z.unknown())`。

- [ ] **Step 1: 包骨架**

`packages/protocol-core/package.json`：

```json
{
  "name": "@pocket-code/protocol-core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": { "build": "tsc", "test": "vitest run src" },
  "dependencies": {
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0",
    "vitest": "^4.0.18"
  }
}
```

`packages/protocol-core/tsconfig.json`：照抄 `packages/agent-core/tsconfig.json`（target ES2022 / module ESNext / moduleResolution bundler / declaration / outDir dist / rootDir src / strict，无需 lib 追加）。

- [ ] **Step 2: 先写放宽锁定测试（TDD）**

`packages/protocol-core/src/envelope.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { RelayRequest, ForwardRequest } from "./envelope";

describe("envelope payload 放宽(中继不认识业务协议)", () => {
  it("accepts arbitrary object payloads", () => {
    expect(
      RelayRequest.safeParse({
        type: "relay-request", token: "t", machineId: "m", requestId: "r",
        payload: { type: "anything-custom", nested: { x: 1 } },
      }).success
    ).toBe(true);
    expect(
      ForwardRequest.safeParse({
        type: "forward-request", token: "t", requestId: "r",
        payload: { whatever: true },
      }).success
    ).toBe(true);
  });

  it("still rejects non-object / missing payloads", () => {
    expect(
      RelayRequest.safeParse({ type: "relay-request", token: "t", machineId: "m", requestId: "r", payload: "str" }).success
    ).toBe(false);
    expect(
      RelayRequest.safeParse({ type: "relay-request", token: "t", machineId: "m", requestId: "r" }).success
    ).toBe(false);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

```bash
pnpm install
pnpm --filter @pocket-code/protocol-core test
```

Expected: FAIL —— `Cannot find module './envelope'`。

- [ ] **Step 4: 写 envelope.ts（relay.ts 的放宽版）**

`packages/protocol-core/src/envelope.ts`（与 `packages/wire/src/relay.ts` 相比：删除 WsMessage import，两处 payload 改 `z.record(z.unknown())`，头注释更新；其余六个 schema 逐字一致）：

```ts
// ── Relay Envelope Schemas ────────────────────────────────
// Wraps opaque payloads for transit through the relay layer.
// 中继不认识业务协议:payload 一律 z.record(z.unknown()),
// 业务校验由隧道两端(如 daemon 的 messageHandler)兜底。

import { z } from "zod";

// ── App → Relay: Request envelope ─────────────────────

export const RelayRequest = z.object({
  type: z.literal("relay-request"),
  /** Device JWT issued by the target daemon during pairing */
  token: z.string().min(1),
  /** Target machine */
  machineId: z.string().min(1).max(128),
  /** Correlation ID for request-response matching */
  requestId: z.string().min(1).max(128),
  /** Opaque business payload (validated by the receiving end) */
  payload: z.record(z.unknown()),
});

export type RelayRequestType = z.infer<typeof RelayRequest>;

// ── Relay → Daemon: Forwarded request ─────────────────

export const ForwardRequest = z.object({
  type: z.literal("forward-request"),
  /** The device JWT for daemon-side verification */
  token: z.string().min(1),
  requestId: z.string().min(1).max(128),
  payload: z.record(z.unknown()),
});

export type ForwardRequestType = z.infer<typeof ForwardRequest>;

// ── Daemon → Relay → App: Response envelope ───────────

export const ForwardResponse = z.object({
  type: z.literal("forward-response"),
  requestId: z.string().min(1).max(128),
  payload: z.record(z.unknown()),
});

export type ForwardResponseType = z.infer<typeof ForwardResponse>;

export const RelayResponse = z.object({
  type: z.literal("relay-response"),
  requestId: z.string().min(1).max(128),
  payload: z.record(z.unknown()),
});

export type RelayResponseType = z.infer<typeof RelayResponse>;

// ── Daemon → Relay → App: Stream envelope ─────────────
// For streaming data (AI text deltas, tool calls, etc.)

export const ForwardStream = z.object({
  type: z.literal("forward-stream"),
  requestId: z.string().min(1).max(128),
  payload: z.record(z.unknown()),
});

export type ForwardStreamType = z.infer<typeof ForwardStream>;

export const RelayStream = z.object({
  type: z.literal("relay-stream"),
  requestId: z.string().min(1).max(128),
  payload: z.record(z.unknown()),
});

export type RelayStreamType = z.infer<typeof RelayStream>;
```

- [ ] **Step 5: 复制 pairing.ts / tunnel.ts / inbound.ts 与两个测试**

- `cp packages/wire/src/pairing.ts packages/protocol-core/src/pairing.ts`（零改动）
- `cp packages/wire/src/tunnel.ts packages/protocol-core/src/tunnel.ts`（零改动）
- `cp packages/wire/src/tunnel.test.ts packages/protocol-core/src/tunnel.test.ts`（零改动——它只从 `./tunnel` 导入）
- `cp packages/wire/src/inbound.ts packages/protocol-core/src/inbound.ts`，唯一改动是把 `from "./relay.js"` 改为 `from "./envelope.js"`（文件更名）：

```ts
import {
  RelayRequest,
  ForwardRequest,
  ForwardResponse,
  ForwardStream,
} from "./envelope.js";
```

- `cp packages/wire/src/inbound.test.ts packages/protocol-core/src/inbound.test.ts`，唯一语义改动：原第 29 行断言"业务非法 payload 被拒"在放宽后翻转。把这一行：

```ts
expect(RelayInbound.safeParse({ type: "relay-request", token: "j", machineId: "m", requestId: "r", payload: { type: "not-a-real-type" } }).success).toBe(false);
```

替换为（保留同一测试块内其余断言不动）：

```ts
// 放宽后:中继不校验业务 payload,任意对象 payload 均通过(业务校验在 daemon 兜底)
expect(RelayInbound.safeParse({ type: "relay-request", token: "j", machineId: "m", requestId: "r", payload: { type: "not-a-real-type" } }).success).toBe(true);
```

（若该测试文件从 `"./inbound"` 之外导入了 wire 内部路径，同步改为本地相对路径。）

- [ ] **Step 6: index.ts 导出面**

`packages/protocol-core/src/index.ts`：

```ts
// ── @pocket-code/protocol-core ───────────────────────────
// 与业务无关的中继协议层:信封、配对/发现、隧道帧、边界 union。
// relay 与 tunnel-client 只依赖本包;业务协议(WsMessage 等)留在 wire。

export {
  RelayRequest, ForwardRequest, ForwardResponse, RelayResponse, ForwardStream, RelayStream,
  type RelayRequestType, type ForwardRequestType, type ForwardResponseType,
  type RelayResponseType, type ForwardStreamType, type RelayStreamType,
} from "./envelope.js";

export {
  PairRequest, PairResponseSuccess, PairResponseError, PairResponse,
  DaemonRegister, DaemonHeartbeat, ListMachines, MachineInfo, ListMachinesResponse,
  type PairRequestType, type PairResponseType, type DaemonRegisterType,
  type DaemonHeartbeatType, type ListMachinesType, type MachineInfoType, type ListMachinesResponseType,
} from "./pairing.js";

export {
  TunnelRequest, TunnelResponse, TunnelChunk, TunnelEnd,
  TunnelWsOpen, TunnelWsOpened, TunnelWsData, TunnelWsClose, TunnelFrame,
  type TunnelRequestType, type TunnelResponseType, type TunnelChunkType, type TunnelEndType,
  type TunnelWsOpenType, type TunnelWsOpenedType, type TunnelWsDataType, type TunnelWsCloseType, type TunnelFrameType,
} from "./tunnel.js";

export {
  RelayErrorMessage, DaemonRegistered, RelayInbound, DaemonInbound,
  type RelayErrorMessageType, type DaemonRegisteredType, type RelayInboundType, type DaemonInboundType,
} from "./inbound.js";
```

- [ ] **Step 7: 跑测试确认通过 + 接线**

根 `package.json` 的 test:all 在 `--filter @pocket-code/wire` 后追加 `--filter @pocket-code/protocol-core`。

```bash
pnpm --filter @pocket-code/protocol-core test && pnpm --filter @pocket-code/protocol-core build
```

Expected: envelope 2 + inbound（原 wire 用例数）+ tunnel（原 wire 用例数）全 PASS；tsc 无错误。

- [ ] **Step 8: Commit**

```bash
git add packages/protocol-core 根package.json pnpm-lock.yaml
git commit -m "feat(protocol-core): 协议核心层建包(信封/配对/隧道/边界union,payload 放宽为 record+锁定测试)"
```

---

### Task 2: wire 降级聚合层 + relay 依赖切换（全仓零改动验证）

**Files:**
- Delete: `packages/wire/src/relay.ts`、`packages/wire/src/pairing.ts`、`packages/wire/src/tunnel.ts`、`packages/wire/src/inbound.ts`、`packages/wire/src/inbound.test.ts`、`packages/wire/src/tunnel.test.ts`
- Modify: `packages/wire/src/index.ts`（四段本地导出改为对 protocol-core 的 re-export）
- Modify: `packages/wire/package.json`（dependencies 加 `"@pocket-code/protocol-core": "workspace:*"`）
- Modify: `packages/relay/src/messageRouter.ts:6`（import 源改 protocol-core）
- Modify: `packages/relay/package.json`（依赖 wire → protocol-core）

**Interfaces:**
- Consumes: Task 1 的 protocol-core 全部导出。
- Produces: `@pocket-code/wire` 导出面与拆分前完全一致（app/server/daemon 零改动）；`@pocket-code/relay` 不再依赖 wire。

- [ ] **Step 1: wire 聚合切换**

删除上述 6 个 wire 源/测试文件。`packages/wire/package.json` dependencies 增加 `"@pocket-code/protocol-core": "workspace:*"`（保留 zod）。

`packages/wire/src/index.ts`：把「Pairing…」「Relay envelope…」「HTTP 隧道帧…」「Boundary inbound unions…」四段 `from "./pairing.js" / "./relay.js" / "./tunnel.js" / "./inbound.js"` 的导出块整体替换为一段（业务层 messages/agentEvent/serverOutbound 导出块保持原样不动）：

```ts
// ── 协议核心层(已拆至 @pocket-code/protocol-core,此处聚合 re-export 保持导入路径兼容) ──
export {
  // 信封
  RelayRequest, ForwardRequest, ForwardResponse, RelayResponse, ForwardStream, RelayStream,
  type RelayRequestType, type ForwardRequestType, type ForwardResponseType,
  type RelayResponseType, type ForwardStreamType, type RelayStreamType,
  // 配对/发现
  PairRequest, PairResponseSuccess, PairResponseError, PairResponse,
  DaemonRegister, DaemonHeartbeat, ListMachines, MachineInfo, ListMachinesResponse,
  type PairRequestType, type PairResponseType, type DaemonRegisterType,
  type DaemonHeartbeatType, type ListMachinesType, type MachineInfoType, type ListMachinesResponseType,
  // 隧道帧
  TunnelRequest, TunnelResponse, TunnelChunk, TunnelEnd,
  TunnelWsOpen, TunnelWsOpened, TunnelWsData, TunnelWsClose, TunnelFrame,
  type TunnelRequestType, type TunnelResponseType, type TunnelChunkType, type TunnelEndType,
  type TunnelWsOpenType, type TunnelWsOpenedType, type TunnelWsDataType, type TunnelWsCloseType, type TunnelFrameType,
  // 边界 union
  RelayErrorMessage, DaemonRegistered, RelayInbound, DaemonInbound,
  type RelayErrorMessageType, type DaemonRegisteredType, type RelayInboundType, type DaemonInboundType,
} from "@pocket-code/protocol-core";
```

- [ ] **Step 2: relay 依赖切换**

`packages/relay/src/messageRouter.ts` 第 6 行：

```ts
import { RelayInbound } from "@pocket-code/protocol-core";
```

`packages/relay/package.json`：dependencies 里 `"@pocket-code/wire": "workspace:*"` 替换为 `"@pocket-code/protocol-core": "workspace:*"`。检查确认 relay 其余源码/测试无 wire 引用：`grep -rn "@pocket-code/wire" packages/relay/src`（Expected: 无输出）。

- [ ] **Step 3: 全仓门禁（零改动验证）**

```bash
pnpm install && pnpm build && pnpm test:all && pnpm typecheck:app
```

Expected: 全绿。wire 剩余测试（messages/serverOutbound/agentEvent）通过；relay 57 例通过；app/server/daemon 未改一行而全绿——聚合层等价性成立。注意 daemon 有一个业务语义受益点：`RelayRequest.payload` 放宽只影响 relay 边界，daemon 的 messageHandler 仍以 `WsMessage.safeParse` 兜底（`packages/server/src/messageHandler.ts:65`），无行为回归。

- [ ] **Step 4: Commit**

```bash
git add packages/wire packages/relay pnpm-lock.yaml
git commit -m "refactor(wire,relay): wire 降级聚合层 re-export protocol-core;relay 只依赖 protocol-core(依赖图自足)"
```

---

### Task 3: RELAY_DISCOVERY 开关（TDD）

**Files:**
- Modify: `packages/relay/src/config.ts`（加 `isDiscoveryEnabled`）
- Modify: `packages/relay/src/config.test.ts`（新 describe）
- Modify: `packages/relay/src/messageRouter.ts`（RouterDeps 加 `discovery?`；两个 case 加闸门）
- Modify: `packages/relay/src/messageRouter.test.ts`（新 describe）
- Modify: `packages/relay/src/index.ts`（读 env 传入 + 启动日志）

**Interfaces:**
- Produces: `isDiscoveryEnabled(env?): boolean`（`RELAY_DISCOVERY=off` 为 false，其余含未设置为 true）；`RouterDeps.discovery?: boolean`（`false` 才关闭；undefined 视为开启——存量测试的 makeDeps 无需改动）。

- [ ] **Step 1: 先写失败测试**

`packages/relay/src/config.test.ts` 追加：

```ts
describe("isDiscoveryEnabled", () => {
  it("defaults to on when unset/empty/other values", () => {
    expect(isDiscoveryEnabled({})).toBe(true);
    expect(isDiscoveryEnabled({ RELAY_DISCOVERY: "" })).toBe(true);
    expect(isDiscoveryEnabled({ RELAY_DISCOVERY: "on" })).toBe(true);
  });
  it("turns off only on 'off' (case/space insensitive)", () => {
    expect(isDiscoveryEnabled({ RELAY_DISCOVERY: "off" })).toBe(false);
    expect(isDiscoveryEnabled({ RELAY_DISCOVERY: " OFF " })).toBe(false);
  });
});
```

（该文件顶部 import 追加 `isDiscoveryEnabled`。）

`packages/relay/src/messageRouter.test.ts` 追加（沿用文件既有 MockWs/asWs/makeDeps/registerDaemonVia/cleanups 基建）：

```ts
describe("RELAY_DISCOVERY=off(纯隧道部署姿态)", () => {
  it("rejects list-machines with an error and does not reveal machines", () => {
    const deps: RouterDeps = { ...makeDeps(), discovery: false };
    const { ws: daemonWs } = registerDaemonVia(deps, "m_disc1");
    cleanups.push(daemonWs);

    const ws = new MockWs();
    const state = createConnState();
    handleRelayInbound(asWs(ws), JSON.stringify({ type: "list-machines" }), state, deps);
    expect(ws.sent.at(-1)).toEqual({ type: "error", error: "Discovery is disabled on this relay" });
    expect(ws.sent.some((m) => m.type === "machines-list")).toBe(false);
  });

  it("rejects pair-request with a failed pair-response (App UI 可显示失败)", () => {
    const deps: RouterDeps = { ...makeDeps(), discovery: false };
    const ws = new MockWs();
    const state = createConnState();
    handleRelayInbound(asWs(ws), JSON.stringify({
      type: "pair-request", pairingCode: "ABCD2345", deviceId: "d1", deviceName: "Phone",
    }), state, deps);
    expect(ws.sent.at(-1)).toEqual({ type: "pair-response", success: false, error: "Pairing is disabled on this relay" });
  });

  it("discovery undefined keeps existing behavior (默认开启)", () => {
    const deps = makeDeps();
    const ws = new MockWs();
    const state = createConnState();
    handleRelayInbound(asWs(ws), JSON.stringify({ type: "list-machines" }), state, deps);
    expect(ws.sent.at(-1).type).toBe("machines-list");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @pocket-code/relay test
```

Expected: FAIL——`isDiscoveryEnabled` 未导出；`discovery` 不在 RouterDeps（TS 编译错）/断言不满足。

- [ ] **Step 3: 实现**

`packages/relay/src/config.ts` 追加：

```ts
/** RELAY_DISCOVERY=off 时关闭发现与配对转发(纯隧道部署姿态);默认 on。 */
export function isDiscoveryEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return (env.RELAY_DISCOVERY || "on").trim().toLowerCase() !== "off";
}
```

`packages/relay/src/messageRouter.ts`：`RouterDeps` 增加字段：

```ts
  /** 发现与配对转发开关(RELAY_DISCOVERY);false 才关闭,undefined 视为开启 */
  discovery?: boolean;
```

`case "list-machines"` 在既有 daemon 角色守卫之后、`state.role = "app"` 之前插入：

```ts
      if (deps.discovery === false) {
        relayLog("Rejected list-machines: discovery disabled");
        sendJSON(ws, { type: "error", error: "Discovery is disabled on this relay" });
        return;
      }
```

`case "pair-request"` 同位置插入：

```ts
      if (deps.discovery === false) {
        relayLog("Rejected pair-request: discovery disabled");
        sendJSON(ws, { type: "pair-response", success: false, error: "Pairing is disabled on this relay" });
        return;
      }
```

`packages/relay/src/index.ts`：import 处从 `./config.js` 增引 `isDiscoveryEnabled`；`RELAY_SECRET` 初始化之后加：

```ts
const DISCOVERY = isDiscoveryEnabled();
console.log(`[Relay] Discovery: ${DISCOVERY ? "on" : "off"}`);
```

`handleRelayInbound` 的 deps 对象增加 `discovery: DISCOVERY,`。

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @pocket-code/relay test && pnpm --filter @pocket-code/relay build
```

Expected: 全 PASS（57 + 新 5 例）。

- [ ] **Step 5: Commit**

```bash
git add packages/relay/src
git commit -m "feat(relay): RELAY_DISCOVERY 开关(off 时拒绝 list-machines/pair-request,纯隧道部署堵发现面)"
```

---

### Task 4: TUNNEL_TOKEN 隧道入口鉴权（含 httpRouter 抽取，TDD）

**Files:**
- Modify: `packages/relay/src/config.ts`（加 `getTunnelToken` / `verifyTunnelToken`）+ `config.test.ts`
- Create: `packages/relay/src/httpRouter.ts`（从 index.ts 抽出 http 处理器并参数化）
- Create: `packages/relay/src/httpRouter.test.ts`
- Modify: `packages/relay/src/tunnelHub.ts:13,26`（extraHeaders 类型放宽为 `Record<string, string | string[]>`）
- Modify: `packages/relay/src/upgradeRouter.ts`（UpgradeDeps 加 `tunnelToken`；隧道分支闸门）+ `upgradeRouter.test.ts`
- Modify: `packages/relay/src/index.ts`（http 处理器换用 createHttpHandler；upgrade deps 传 tunnelToken；启动日志）

**Interfaces:**
- Consumes: Task 3 的 config 模式。
- Produces: `getTunnelToken(env?): string | null`（trim 后空 → null=不启用）；`verifyTunnelToken(expected: string, given: string | null | undefined): boolean`（timingSafeEqual，长度不等先短路）；`createHttpHandler(deps: HttpRouterDeps)`，`HttpRouterDeps = { tunnelHub: TunnelHub; sendToDaemon(machineId, frame): boolean; getOnlineMachineCount(): number; port: number; tunnelToken: string | null }`；`UpgradeDeps.tunnelToken: string | null`。
- 语义：鉴权失败一律 404（HTTP JSON / upgrade 原始 404 后 destroy），不区分未授权与不存在；`pc_token` 查询参数校验通过后由响应种 `pc_tunnel_token` HttpOnly cookie，且该参数**从转发给 daemon 的 path 中剥除**。

- [ ] **Step 1: 先写 config 测试**

`packages/relay/src/config.test.ts` 追加（import 加 `getTunnelToken, verifyTunnelToken`）：

```ts
describe("tunnel token", () => {
  it("getTunnelToken: 空/未设置 → null(不启用)", () => {
    expect(getTunnelToken({})).toBeNull();
    expect(getTunnelToken({ TUNNEL_TOKEN: "  " })).toBeNull();
    expect(getTunnelToken({ TUNNEL_TOKEN: " tok " })).toBe("tok");
  });
  it("verifyTunnelToken: 等值通过,错值/缺失/前缀不通过", () => {
    expect(verifyTunnelToken("tok", "tok")).toBe(true);
    expect(verifyTunnelToken("tok", "bad")).toBe(false);
    expect(verifyTunnelToken("tok", "to")).toBe(false);
    expect(verifyTunnelToken("tok", undefined)).toBe(false);
    expect(verifyTunnelToken("tok", null)).toBe(false);
  });
});
```

- [ ] **Step 2: 写 httpRouter 集成测试（真 http server）**

`packages/relay/src/httpRouter.test.ts`：

```ts
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "http";
import { createHttpHandler } from "./httpRouter.js";
import { TunnelHub } from "./tunnelHub.js";

interface Ctx { server: Server; port: number; hub: TunnelHub; frames: any[]; }

async function startHttp(tunnelToken: string | null): Promise<Ctx> {
  const hub = new TunnelHub();
  const frames: any[] = [];
  const server = createServer(
    createHttpHandler({
      tunnelHub: hub,
      sendToDaemon: (machineId, frame) => { frames.push({ machineId, frame }); return true; },
      getOnlineMachineCount: () => 1,
      port: 0,
      tunnelToken,
    })
  );
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  return { server, hub, frames, port: typeof addr === "object" && addr ? addr.port : 0 };
}

const ctxs: Ctx[] = [];
afterEach(() => { for (const c of ctxs.splice(0)) c.server.close(); });

/** 发起隧道请求并用 hub 以 owner 身份回帧,拿到完整响应 */
async function fetchViaTunnel(ctx: Ctx, path: string, headers: Record<string, string> = {}) {
  const respP = fetch(`http://127.0.0.1:${ctx.port}${path}`, { headers, redirect: "manual" });
  // 等待 tunnel-request 帧到达(鉴权失败时不会到达)
  const t0 = Date.now();
  while (!ctx.frames.length && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 10));
  if (ctx.frames.length) {
    const { machineId, frame } = ctx.frames[0];
    ctx.hub.onResponse(frame.tunnelId, 200, { "content-type": "text/plain" }, machineId);
    ctx.hub.onChunk(frame.tunnelId, Buffer.from(`echo:${frame.path}`).toString("base64"), machineId);
    ctx.hub.onEnd(frame.tunnelId, undefined, machineId);
  }
  return respP;
}

describe("createHttpHandler", () => {
  it("health 正常返回", async () => {
    const ctx = await startHttp(null); ctxs.push(ctx);
    const resp = await fetch(`http://127.0.0.1:${ctx.port}/health`);
    expect(resp.status).toBe(200);
    expect((await resp.json()).machines).toBe(1);
  });

  it("token 关闭时 /t/ 路径直通并种 pc_tunnel cookie(现状不变)", async () => {
    const ctx = await startHttp(null); ctxs.push(ctx);
    const resp = await fetchViaTunnel(ctx, "/t/m_1/5173/hello?x=1");
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("echo:/hello?x=1");
    expect(resp.headers.getSetCookie().join(";")).toContain("pc_tunnel=m_1:5173");
    expect(ctx.frames[0].frame.path).toBe("/hello?x=1");
  });

  it("token 开启:无 token 404 且不转发", async () => {
    const ctx = await startHttp("tok"); ctxs.push(ctx);
    const resp = await fetch(`http://127.0.0.1:${ctx.port}/t/m_1/5173/`);
    expect(resp.status).toBe(404);
    expect(ctx.frames).toHaveLength(0);
  });

  it("token 开启:pc_token 查询参数通过,种 HttpOnly cookie,且 token 不进转发 path", async () => {
    const ctx = await startHttp("tok"); ctxs.push(ctx);
    const resp = await fetchViaTunnel(ctx, "/t/m_1/5173/hello?pc_token=tok&x=1");
    expect(resp.status).toBe(200);
    const cookies = resp.headers.getSetCookie().join(";;");
    expect(cookies).toContain("pc_tunnel=m_1:5173");
    expect(cookies).toContain("pc_tunnel_token=tok");
    expect(cookies).toContain("HttpOnly");
    expect(ctx.frames[0].frame.path).toBe("/hello?x=1"); // pc_token 已剥除
  });

  it("token 开启:cookie 路径带合法 pc_tunnel_token 通过,错误 token 404", async () => {
    const ctx = await startHttp("tok"); ctxs.push(ctx);
    const ok = await fetchViaTunnel(ctx, "/sub.js", { cookie: "pc_tunnel=m_1:5173; pc_tunnel_token=tok" });
    expect(ok.status).toBe(200);
    expect(ctx.frames[0].frame.path).toBe("/sub.js");

    const ctx2 = await startHttp("tok"); ctxs.push(ctx2);
    const bad = await fetch(`http://127.0.0.1:${ctx2.port}/sub.js`, {
      headers: { cookie: "pc_tunnel=m_1:5173; pc_tunnel_token=wrong" },
    });
    expect(bad.status).toBe(404);
    expect(ctx2.frames).toHaveLength(0);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

```bash
pnpm --filter @pocket-code/relay test
```

Expected: FAIL——`Cannot find module './httpRouter.js'`、config 新函数未定义。

- [ ] **Step 4: 实现 config 函数**

`packages/relay/src/config.ts` 追加：

```ts
/** TUNNEL_TOKEN:trim 后非空才启用隧道入口鉴权;否则 null(现状:machineId 即能力凭证)。 */
export function getTunnelToken(
  env: Record<string, string | undefined> = process.env
): string | null {
  const t = (env.TUNNEL_TOKEN || "").trim();
  return t || null;
}

/** 常量时间比较隧道 token(等长前置短路,同 verifyDaemonAuth 手法)。 */
export function verifyTunnelToken(expected: string, given: string | null | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

- [ ] **Step 5: 实现 httpRouter.ts（index.ts 处理器的参数化搬迁 + 鉴权）**

`packages/relay/src/httpRouter.ts`（`startTunnel`/路由逻辑与现 `index.ts:53-127` 一致，差异：依赖注入、token 闸门、pc_token 剥除、双 Set-Cookie）：

```ts
// ── HTTP 入口(健康检查 + 反向隧道路由),从 index.ts 抽出可测 ──
// TUNNEL_TOKEN 设置时,隧道入口(显式 /t/ 与 pc_tunnel cookie 路径)强制鉴权:
// 首次 ?pc_token=<v> 校验通过后种 pc_tunnel_token HttpOnly cookie;失败一律 404。

import crypto from "crypto";
import type { IncomingMessage, ServerResponse } from "http";
import type { TunnelHub } from "./tunnelHub.js";
import { verifyTunnelToken } from "./config.js";

export interface HttpRouterDeps {
  tunnelHub: TunnelHub;
  sendToDaemon: (machineId: string, frame: unknown) => boolean;
  getOnlineMachineCount: () => number;
  port: number;
  /** null=不启用隧道入口鉴权(默认,与现状一致) */
  tunnelToken: string | null;
}

const TUNNEL_TOKEN_COOKIE_RE = /(?:^|;\s*)pc_tunnel_token=([^;]+)/;
const TUNNEL_COOKIE_RE = /(?:^|;\s*)pc_tunnel=([^:;]+):(\d+)/;

export function createHttpHandler(deps: HttpRouterDeps) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    res.setHeader("Access-Control-Allow-Origin", "*");

    const url = new URL(req.url || "", `http://localhost:${deps.port || 80}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          timestamp: Date.now(),
          machines: deps.getOnlineMachineCount(),
        })
      );
      return;
    }

    const notFound = () => {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not Found" }));
    };

    // ── 隧道入口鉴权(TUNNEL_TOKEN 未设置时恒通过) ──
    const queryToken = url.searchParams.get("pc_token");
    const cookieToken = ((req.headers.cookie || "").match(TUNNEL_TOKEN_COOKIE_RE) || [])[1];
    const tokenOk =
      deps.tunnelToken === null ||
      verifyTunnelToken(deps.tunnelToken, queryToken) ||
      verifyTunnelToken(deps.tunnelToken, cookieToken);

    // pc_token 只用于鉴权,不进转发 path(避免污染目标服务的请求)
    url.searchParams.delete("pc_token");
    const search = url.searchParams.toString() ? `?${url.searchParams.toString()}` : "";

    // 启动一条隧道:收齐请求体后转给 daemon。
    const startTunnel = (
      machineId: string,
      port: number,
      path: string,
      extraHeaders?: Record<string, string | string[]>
    ) => {
      const tunnelId = crypto.randomUUID();
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers[k] = v;
        else if (Array.isArray(v)) headers[k] = v.join(", ");
      }
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        const body = chunks.length ? Buffer.concat(chunks).toString("base64") : undefined;
        deps.tunnelHub.open(tunnelId, res, machineId, extraHeaders);
        const ok = deps.sendToDaemon(machineId, {
          type: "tunnel-request",
          tunnelId,
          port,
          method: req.method || "GET",
          path,
          headers,
          body,
        });
        if (!ok) deps.tunnelHub.onEnd(tunnelId, `daemon ${machineId} offline`);
      });
    };

    // ── 显式隧道: /t/<machineId>/<port>/<rest> ──
    // 顺便下发 pc_tunnel cookie,使该页的「绝对路径子资源」(如 vite 的 /src/x)
    // 也能被路由回同一隧道(否则绝对路径会丢掉 /t/<id>/<port> 前缀而 404)。
    const tunnelMatch = url.pathname.match(/^\/t\/([^/]+)\/(\d+)(\/.*)?$/);
    if (tunnelMatch) {
      if (!tokenOk) return notFound();
      const [, machineId, portStr, rest] = tunnelMatch;
      const port = parseInt(portStr, 10);
      const setCookies = [`pc_tunnel=${machineId}:${port}; Path=/; SameSite=Lax`];
      if (deps.tunnelToken !== null && queryToken && verifyTunnelToken(deps.tunnelToken, queryToken)) {
        setCookies.push(`pc_tunnel_token=${queryToken}; Path=/; HttpOnly; SameSite=Lax`);
      }
      startTunnel(machineId, port, (rest || "/") + search, { "Set-Cookie": setCookies });
      return;
    }

    // ── 绝对路径子资源:靠 pc_tunnel cookie 路由回同一隧道 ──
    const cookieMatch = (req.headers.cookie || "").match(TUNNEL_COOKIE_RE);
    if (cookieMatch) {
      if (!tokenOk) return notFound();
      startTunnel(cookieMatch[1], parseInt(cookieMatch[2], 10), url.pathname + search);
      return;
    }

    notFound();
  };
}
```

`packages/relay/src/tunnelHub.ts`：`PendingTunnel.extraHeaders` 与 `open()` 第 4 参类型由 `Record<string, string>` 放宽为 `Record<string, string | string[]>`；`onResponse` 内组装响应头的局部变量 `safe` 类型同步放宽为 `Record<string, string | string[]>`（`res.writeHead` 原生支持 string[]，Set-Cookie 多值必须数组）。

- [ ] **Step 6: upgradeRouter 闸门**

`packages/relay/src/upgradeRouter.ts`：
1. import 追加 `import { verifyTunnelToken } from "./config.js";`，正则区追加 `const TUNNEL_TOKEN_COOKIE_RE = /(?:^|;\s*)pc_tunnel_token=([^;]+)/;`
2. `UpgradeDeps` 增加 `/** null=不启用隧道入口鉴权 */ tunnelToken: string | null;`
3. `dispatchUpgrade` 中，在 `if (!machineId) { ...控制通道... }` 之前插入（只闸隧道路由，控制通道不受影响；同时把 `path` 里的 pc_token 剥除）：

```ts
    if (machineId) {
      const queryToken = url.searchParams.get("pc_token");
      const cookieToken = ((req.headers.cookie || "").match(TUNNEL_TOKEN_COOKIE_RE) || [])[1];
      const ok =
        deps.tunnelToken === null ||
        verifyTunnelToken(deps.tunnelToken, queryToken) ||
        verifyTunnelToken(deps.tunnelToken, cookieToken);
      if (!ok) {
        // 与 HTTP 路径同语义:一律 404,不给探测信号
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      // pc_token 只用于鉴权,不进转发 path
      url.searchParams.delete("pc_token");
      const cleaned = url.searchParams.toString() ? `?${url.searchParams.toString()}` : "";
      path = path.split("?")[0] + cleaned;
    }
```

`packages/relay/src/upgradeRouter.test.ts`：`startRelay` 改为接收可选 token（存量调用不改）——签名 `async function startRelay(tunnelToken: string | null = null)`，deps 里传 `tunnelToken`。新增用例：

```ts
  it("TUNNEL_TOKEN 开启:无 token 的隧道 upgrade 被 404 拒绝", async () => {
    const ctx = await startRelay("tok"); ctxs.push(ctx);
    const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/t/m_X/5173/hmr`);
    await new Promise<void>((res) => ws.on("error", () => res()));
    expect(ctx.daemonFrames).toHaveLength(0);
  });

  it("TUNNEL_TOKEN 开启:pc_token 查询参数通过且不进转发 path;控制通道不受影响", async () => {
    const ctx = await startRelay("tok"); ctxs.push(ctx);
    const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/t/m_X/5173/hmr?pc_token=tok&y=2`);
    await waitOpen(ws);
    await until(() => ctx.daemonFrames.some((d) => d.frame.type === "tunnel-ws-open"));
    const open = ctx.daemonFrames.find((d) => d.frame.type === "tunnel-ws-open");
    expect(open.frame.path).toBe("/hmr?y=2");
    ws.close();

    const ctrl = new WebSocket(`ws://127.0.0.1:${ctx.port}/relay`);
    await waitOpen(ctrl);
    await until(() => ctx.controlConnections === 1);
    ctrl.close();
  });

  it("TUNNEL_TOKEN 开启:pc_tunnel_token cookie 通过", async () => {
    const ctx = await startRelay("tok"); ctxs.push(ctx);
    const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/`, {
      headers: { cookie: "pc_tunnel=m_Y:3000; pc_tunnel_token=tok" },
    });
    await waitOpen(ws);
    await until(() => ctx.daemonFrames.some((d) => d.frame.type === "tunnel-ws-open"));
    ws.close();
  });
```

- [ ] **Step 7: index.ts 接线**

`packages/relay/src/index.ts`：
1. 删除原第 53-127 行的整个 `createServer((req,res)=>{...})` 内联处理器与其专用 import（`crypto` 若仅此处使用则一并移除；`IncomingMessage/ServerResponse` type import 移除）。
2. import 追加 `import { createHttpHandler } from "./httpRouter.js";` 与 config 的 `getTunnelToken`。
3. `DISCOVERY` 日志行后追加：

```ts
const TUNNEL_TOKEN = getTunnelToken();
console.log(`[Relay] Tunnel ingress auth: ${TUNNEL_TOKEN ? "TUNNEL_TOKEN required" : "open (machineId is the capability)"}`);
```

4. 服务器创建改为：

```ts
const httpServer = createServer(
  createHttpHandler({
    tunnelHub,
    sendToDaemon: sendRawToDaemon,
    getOnlineMachineCount: () => getOnlineMachines().length,
    port: PORT,
    tunnelToken: TUNNEL_TOKEN,
  })
);
```

5. `createUpgradeHandler({...})` deps 增加 `tunnelToken: TUNNEL_TOKEN,`。

- [ ] **Step 8: 跑测试确认通过**

```bash
pnpm --filter @pocket-code/relay test && pnpm --filter @pocket-code/relay build
```

Expected: 全 PASS（含 httpRouter 6 例、upgradeRouter 新 3 例、config 新 2 例；存量 upgradeRouter/messageRouter 等不回归）。

- [ ] **Step 9: Commit**

```bash
git add packages/relay/src
git commit -m "feat(relay): TUNNEL_TOKEN 隧道入口鉴权(http+ws upgrade,404 语义/HttpOnly cookie/pc_token 剥除)+httpRouter 抽取可测"
```

---

### Task 5: tunnel-client 包（connection/tunnel/inbound 迁入 + startTunnelClient，TDD）

**Files:**
- Create: `packages/tunnel-client/package.json`、`packages/tunnel-client/tsconfig.json`
- Create: `packages/tunnel-client/src/connection.ts`（源自 `packages/daemon/src/connection.ts`）
- Create: `packages/tunnel-client/src/tunnel.ts`（源自 `packages/daemon/src/tunnel.ts`）
- Create: `packages/tunnel-client/src/inbound.ts`（源自 `packages/daemon/src/inbound.ts`）
- Create: `packages/tunnel-client/src/client.ts`（新）
- Create: `packages/tunnel-client/src/index.ts`
- Create: `packages/tunnel-client/src/tunnel.test.ts`（复制 daemon 同名测试）
- Create: `packages/tunnel-client/src/inbound.test.ts`（复制 daemon 同名测试）
- Create: `packages/tunnel-client/src/client.test.ts`（新）
- Modify: 根 `package.json`（test:all 在 `--filter @pocket-code/relay` 后追加 `--filter @pocket-code/tunnel-client`）

**Interfaces:**
- Consumes: protocol-core 的 `DaemonInbound`/`DaemonInboundType`。
- Produces:

```ts
export interface TunnelClientOptions {
  relayUrl: string;
  relaySecret: string;
  machineId: string;
  machineName: string;
  /** 非隧道消息(pair-request/forward-request)委托;未提供时回 tunnel-only 错误帧 */
  onMessage?: (msg: DaemonInboundType, send: (data: unknown) => boolean) => void;
  onConnected?: () => void;
  onDisconnected?: () => void;
}
export interface TunnelClientHandle { send(data: unknown): boolean; stop(): void; }
export function startTunnelClient(opts: TunnelClientOptions): TunnelClientHandle;
/** 纯分发函数(可测):startTunnelClient 内部使用 */
export function handleTunnelClientMessage(
  msg: DaemonInboundType,
  send: (data: unknown) => boolean,
  onMessage?: TunnelClientOptions["onMessage"]
): void;
```

（`RelayConnection`、`proxyToLocalhost` 等迁移符号也从 index 导出，签名与 daemon 现版一致。）

- [ ] **Step 1: 包骨架**

`packages/tunnel-client/package.json`：

```json
{
  "name": "@pocket-code/tunnel-client",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": { "build": "tsc", "test": "vitest run src" },
  "dependencies": {
    "@pocket-code/protocol-core": "workspace:*",
    "dotenv": "^16.4.0",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/ws": "^8.5.0",
    "typescript": "^5.7.0",
    "vitest": "^4.0.18"
  }
}
```

`packages/tunnel-client/tsconfig.json`：照抄 `packages/agent-core/tsconfig.json` 并追加 `"lib": ["ES2022", "DOM"]`（tunnel.ts 用 fetch/ReadableStream 全局类型）。

- [ ] **Step 2: 先写 client 分发失败测试**

`packages/tunnel-client/src/client.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";
import { handleTunnelClientMessage } from "./client";
import type { DaemonInboundType } from "@pocket-code/protocol-core";

function collect() {
  const sent: any[] = [];
  return { sent, send: (d: unknown) => { sent.push(d); return true; } };
}

describe("handleTunnelClientMessage(tunnel-only 与委托边界)", () => {
  it("forward-request 无 onMessage 时回 tunnel-only 错误帧(对端不挂起)", () => {
    const { sent, send } = collect();
    handleTunnelClientMessage(
      { type: "forward-request", token: "t", requestId: "r1", payload: { type: "message" } } as DaemonInboundType,
      send
    );
    expect(sent).toEqual([
      { type: "forward-response", requestId: "r1", payload: { type: "error", error: "This endpoint is a tunnel-only client" } },
    ]);
  });

  it("pair-request 无 onMessage 时回失败 pair-response", () => {
    const { sent, send } = collect();
    handleTunnelClientMessage(
      { type: "pair-request", pairingCode: "ABCD2345", deviceId: "d1", deviceName: "Phone" } as DaemonInboundType,
      send
    );
    expect(sent).toEqual([
      { type: "pair-response", success: false, error: "Pairing is not supported by this tunnel client" },
    ]);
  });

  it("提供 onMessage 时 pair/forward 均委托,自己不回帧", () => {
    const { sent, send } = collect();
    const onMessage = vi.fn();
    const msg = { type: "forward-request", token: "t", requestId: "r1", payload: {} } as DaemonInboundType;
    handleTunnelClientMessage(msg, send, onMessage);
    expect(onMessage).toHaveBeenCalledWith(msg, send);
    expect(sent).toHaveLength(0);
  });

  it("未知 tunnelId 的 tunnel-ws-data/close 不抛异常", () => {
    const { send } = collect();
    expect(() =>
      handleTunnelClientMessage({ type: "tunnel-ws-data", tunnelId: "nope", data: "x" } as DaemonInboundType, send)
    ).not.toThrow();
    expect(() =>
      handleTunnelClientMessage({ type: "tunnel-ws-close", tunnelId: "nope" } as DaemonInboundType, send)
    ).not.toThrow();
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

```bash
pnpm install && pnpm --filter @pocket-code/tunnel-client test
```

Expected: FAIL —— `Cannot find module './client'`。

- [ ] **Step 4: 迁移三个源文件 + 两个测试**

- `cp packages/daemon/src/connection.ts packages/tunnel-client/src/connection.ts`，两处改动：
  1. `import type { DaemonInboundType } from "@pocket-code/wire";` → `from "@pocket-code/protocol-core";`
  2. 日志前缀全文件 `[Daemon]` → `[Tunnel]`（5 处 console）。
- `cp packages/daemon/src/tunnel.ts packages/tunnel-client/src/tunnel.ts`，改动：日志前缀 `[Daemon]` → `[Tunnel]`（2 处 console.warn）。
- `cp packages/daemon/src/inbound.ts packages/tunnel-client/src/inbound.ts`，改动：import 源 wire → `@pocket-code/protocol-core`；日志前缀 `[Daemon]` → `[Tunnel]`（2 处）。
- `cp packages/daemon/src/tunnel.test.ts packages/tunnel-client/src/tunnel.test.ts`（零改动——只从 `./tunnel` 导入）。
- `cp packages/daemon/src/inbound.test.ts packages/tunnel-client/src/inbound.test.ts`（若其中引用 wire 则改为 `@pocket-code/protocol-core`）。

- [ ] **Step 5: 实现 client.ts 与 index.ts**

`packages/tunnel-client/src/client.ts`：

```ts
// ── 隧道客户端编排:RelayConnection + 隧道帧自消化 + 非隧道消息委托 ──
// relay+tunnel-client 即完整"类 ngrok":本文件是内网侧入口。
// pair-request/forward-request 属宿主业务(daemon 注入 onMessage 处理);
// 独立 CLI(tunnel-only)模式下明确回错误帧,不让对端挂起。

import type { DaemonInboundType } from "@pocket-code/protocol-core";
import { RelayConnection } from "./connection.js";
import {
  proxyToLocalhost,
  openLocalWebSocket,
  onWsTunnelData,
  onWsTunnelClose,
  closeAllWsTunnels,
} from "./tunnel.js";

export interface TunnelClientOptions {
  relayUrl: string;
  relaySecret: string;
  machineId: string;
  machineName: string;
  /** 非隧道消息(pair-request/forward-request)委托;未提供时回 tunnel-only 错误帧 */
  onMessage?: (msg: DaemonInboundType, send: (data: unknown) => boolean) => void;
  onConnected?: () => void;
  onDisconnected?: () => void;
}

export interface TunnelClientHandle {
  send(data: unknown): boolean;
  stop(): void;
}

/** 纯分发(可测):隧道帧自消化,其余委托或回绝。 */
export function handleTunnelClientMessage(
  msg: DaemonInboundType,
  send: (data: unknown) => boolean,
  onMessage?: TunnelClientOptions["onMessage"]
): void {
  switch (msg.type) {
    case "daemon-registered":
      console.log("[Tunnel] Registration confirmed by relay");
      return;
    case "tunnel-request":
      proxyToLocalhost(
        {
          tunnelId: msg.tunnelId,
          port: msg.port,
          method: msg.method,
          path: msg.path,
          headers: msg.headers || {},
          body: msg.body,
        },
        (frame) => send(frame)
      ).catch((err: any) => {
        send({ type: "tunnel-end", tunnelId: msg.tunnelId, error: err?.message ?? "tunnel error" });
      });
      return;
    case "tunnel-ws-open":
      openLocalWebSocket(
        { tunnelId: msg.tunnelId, port: msg.port, path: msg.path, headers: msg.headers },
        (frame) => send(frame)
      );
      return;
    case "tunnel-ws-data":
      onWsTunnelData(msg.tunnelId, msg.data, msg.binary);
      return;
    case "tunnel-ws-close":
      onWsTunnelClose(msg.tunnelId, msg.code, msg.reason);
      return;
    case "error":
      console.error("[Tunnel] Relay error:", msg.error);
      return;
    case "pair-request":
    case "forward-request": {
      if (onMessage) {
        onMessage(msg, send);
        return;
      }
      if (msg.type === "forward-request") {
        send({
          type: "forward-response",
          requestId: msg.requestId,
          payload: { type: "error", error: "This endpoint is a tunnel-only client" },
        });
      } else {
        send({ type: "pair-response", success: false, error: "Pairing is not supported by this tunnel client" });
      }
      return;
    }
  }
}

export function startTunnelClient(opts: TunnelClientOptions): TunnelClientHandle {
  const connection = new RelayConnection({
    relayUrl: opts.relayUrl,
    machineId: opts.machineId,
    machineName: opts.machineName,
    relaySecret: opts.relaySecret,
    onConnected() {
      opts.onConnected?.();
    },
    onDisconnected() {
      closeAllWsTunnels(); // 浏览器侧已不可达
      opts.onDisconnected?.();
    },
    onMessage(msg) {
      handleTunnelClientMessage(msg, send, opts.onMessage);
    },
  });
  const send = (data: unknown) => connection.send(data);

  connection.connect();
  return { send, stop: () => connection.disconnect() };
}
```

`packages/tunnel-client/src/index.ts`：

```ts
export { startTunnelClient, handleTunnelClientMessage } from "./client.js";
export type { TunnelClientOptions, TunnelClientHandle } from "./client.js";
export { RelayConnection, type ConnectionOptions } from "./connection.js";
export {
  proxyToLocalhost, openLocalWebSocket, onWsTunnelData, onWsTunnelClose,
  closeAllWsTunnels, clampCloseCode,
  type TunnelHttpRequest, type TunnelFrame, type TunnelWsOpenRequest,
} from "./tunnel.js";
export { parseRelayMessage } from "./inbound.js";
```

- [ ] **Step 6: 跑测试确认通过 + 接线**

根 `package.json` test:all 在 `--filter @pocket-code/relay` 后追加 `--filter @pocket-code/tunnel-client`。

```bash
pnpm --filter @pocket-code/tunnel-client test && pnpm --filter @pocket-code/tunnel-client build
```

Expected: client 4 例 + 迁入的 tunnel/inbound 测试全 PASS；tsc 无错误。

- [ ] **Step 7: Commit**

```bash
git add packages/tunnel-client 根package.json pnpm-lock.yaml
git commit -m "feat(tunnel-client): 隧道客户端包(connection/tunnel/inbound 迁入+startTunnelClient 可插拔边界,分发测试 4 例)"
```

---

### Task 6: daemon 切换复用 tunnel-client

**Files:**
- Delete: `packages/daemon/src/connection.ts`、`packages/daemon/src/tunnel.ts`、`packages/daemon/src/inbound.ts`、`packages/daemon/src/tunnel.test.ts`、`packages/daemon/src/inbound.test.ts`
- Modify: `packages/daemon/src/index.ts`（接线 startTunnelClient；handleRelayMessage 瘦身）
- Modify: `packages/daemon/package.json`（dependencies 加 `"@pocket-code/tunnel-client": "workspace:*"`）

**Interfaces:**
- Consumes: Task 5 的 `startTunnelClient`/`TunnelClientHandle`。
- Produces: daemon 行为等价（注册/心跳/隧道/配对/业务转发全不变），但隧道与连接逻辑来自 tunnel-client；连接类日志前缀变为 `[Tunnel]`（已知且接受的表象变化）。

- [ ] **Step 1: 删除迁移源与测试**

```bash
git rm packages/daemon/src/connection.ts packages/daemon/src/tunnel.ts packages/daemon/src/inbound.ts packages/daemon/src/tunnel.test.ts packages/daemon/src/inbound.test.ts
```

- [ ] **Step 2: index.ts 接线**

`packages/daemon/src/index.ts` 改动：

1. import 区：删除 `import { RelayConnection } from "./connection.js";` 与 `import { proxyToLocalhost, openLocalWebSocket, onWsTunnelData, onWsTunnelClose, closeAllWsTunnels } from "./tunnel.js";`，新增：

```ts
import { startTunnelClient, type TunnelClientHandle } from "@pocket-code/tunnel-client";
```

2. `// ── Connect to Relay ──` 段整体替换为：

```ts
const connection: TunnelClientHandle = startTunnelClient({
  relayUrl: RELAY_URL,
  machineId: MACHINE_ID,
  machineName: MACHINE_NAME,
  relaySecret: RELAY_SECRET,

  onConnected() {
    console.log("[Daemon] Registered with relay. Waiting for connections...");
  },

  onDisconnected() {
    console.log("[Daemon] Lost connection to relay.");
  },

  // 隧道帧由 tunnel-client 自消化;这里只接业务消息(pair-request/forward-request)
  onMessage(msg: DaemonInboundType) {
    handleRelayMessage(msg);
  },
});
```

（原 `connection.connect();` 行删除——startTunnelClient 内部已 connect。`closeAllWsTunnels()` 调用随 onDisconnected 移入 tunnel-client，不再需要。）

3. `handleRelayMessage` 瘦身：删除 `case "daemon-registered"`、`case "tunnel-request"`、`case "tunnel-ws-open"`、`case "tunnel-ws-data"`、`case "tunnel-ws-close"`、`case "error"` 六个分支（tunnel-client 已处理，onMessage 只会收到 pair-request/forward-request 两类），保留 `pair-request`、`forward-request` 分支与 default 兜底日志原样不动。函数内所有 `connection.send(...)` 调用无需改动（TunnelClientHandle.send 同签名）。

4. shutdown 函数：`connection.disconnect();` → `connection.stop();`

5. `packages/daemon/package.json` dependencies 增加 `"@pocket-code/tunnel-client": "workspace:*"`（保留 wire——`DaemonInboundType`/`ServerOutboundType` 类型仍从 wire 导入，聚合层继续可用）。

- [ ] **Step 3: 全仓门禁**

```bash
pnpm install && pnpm build && pnpm test:all && pnpm typecheck:app
```

Expected: 全绿。daemon 剩余测试（config/pairing）通过；tunnel/inbound 测试已在 tunnel-client 侧计入。

- [ ] **Step 4: Commit**

```bash
git add -A packages/daemon 根package.json pnpm-lock.yaml
git commit -m "refactor(daemon): 切换复用 tunnel-client(删自有 connection/tunnel/inbound,业务消息经 onMessage 委托)"
```

---

### Task 7: pocket-tunnel CLI（身份持久化 + 参数解析，TDD）

**Files:**
- Create: `packages/tunnel-client/src/identity.ts`、`packages/tunnel-client/src/identity.test.ts`
- Create: `packages/tunnel-client/src/cli.ts`
- Modify: `packages/tunnel-client/package.json`（加 `"bin": { "pocket-tunnel": "dist/cli.js" }`）
- Modify: `packages/tunnel-client/src/index.ts`（导出 identity）

**Interfaces:**
- Produces: `loadOrCreateIdentity(filePath?: string, defaultName?: string): { machineId: string; machineName: string }`——默认路径 `~/.pocket-tunnel.json`，首次生成 `m_` + 8 随机字节 hex 并以 0600 落盘；后续读取复用；损坏文件按首次处理。CLI：`pocket-tunnel --relay <ws-url> --secret <RELAY_SECRET> [--name <name>]`，env 兜底 RELAY_URL/RELAY_SECRET/MACHINE_NAME。

- [ ] **Step 1: 先写身份持久化失败测试**

`packages/tunnel-client/src/identity.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadOrCreateIdentity } from "./identity";

describe("loadOrCreateIdentity", () => {
  it("首次生成 m_ 前缀 id 并落盘,二次读取稳定复用", () => {
    const file = join(mkdtempSync(join(tmpdir(), "pt-")), "id.json");
    const first = loadOrCreateIdentity(file, "box");
    expect(first.machineId).toMatch(/^m_[0-9a-f]{16}$/);
    expect(first.machineName).toBe("box");
    const second = loadOrCreateIdentity(file, "other-name");
    expect(second.machineId).toBe(first.machineId);
    // 落盘的 name 优先于 defaultName
    expect(second.machineName).toBe("box");
    expect(JSON.parse(readFileSync(file, "utf-8")).machineId).toBe(first.machineId);
  });

  it("损坏文件按首次处理重建", () => {
    const file = join(mkdtempSync(join(tmpdir(), "pt-")), "id.json");
    writeFileSync(file, "not-json{{{");
    const identity = loadOrCreateIdentity(file, "box");
    expect(identity.machineId).toMatch(/^m_[0-9a-f]{16}$/);
    expect(JSON.parse(readFileSync(file, "utf-8")).machineId).toBe(identity.machineId);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @pocket-code/tunnel-client test
```

Expected: FAIL —— `Cannot find module './identity'`。

- [ ] **Step 3: 实现 identity.ts 与 cli.ts**

`packages/tunnel-client/src/identity.ts`：

```ts
// ── CLI 身份持久化(对齐 daemon 的 ~/.pocket-code/machine-id 模式) ──

import crypto from "crypto";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { homedir, hostname } from "os";

export interface TunnelIdentity {
  machineId: string;
  machineName: string;
}

export function loadOrCreateIdentity(
  filePath: string = join(homedir(), ".pocket-tunnel.json"),
  defaultName: string = hostname()
): TunnelIdentity {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
    if (parsed && typeof parsed.machineId === "string" && parsed.machineId) {
      return {
        machineId: parsed.machineId,
        machineName:
          typeof parsed.machineName === "string" && parsed.machineName ? parsed.machineName : defaultName,
      };
    }
  } catch {
    /* 首次运行或损坏:重建 */
  }
  const identity: TunnelIdentity = {
    machineId: `m_${crypto.randomBytes(8).toString("hex")}`,
    machineName: defaultName,
  };
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(identity, null, 2), { mode: 0o600 });
  return identity;
}
```

`packages/tunnel-client/src/cli.ts`：

```ts
#!/usr/bin/env node
// ── pocket-tunnel:最小隧道客户端 CLI(tunnel-only,不含 agent/配对业务) ──
// 用法:pocket-tunnel --relay wss://host/relay --secret <RELAY_SECRET> [--name my-machine]
// env 兜底:RELAY_URL / RELAY_SECRET / MACHINE_NAME

import { config as loadEnv } from "dotenv";
loadEnv();
import { loadOrCreateIdentity } from "./identity.js";
import { startTunnelClient } from "./client.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : undefined;
}

const relayUrl = arg("relay") || process.env.RELAY_URL || "";
const relaySecret = arg("secret") || process.env.RELAY_SECRET || "";
if (!relayUrl || !relaySecret) {
  console.error("用法:pocket-tunnel --relay wss://host/relay --secret <RELAY_SECRET> [--name my-machine]");
  console.error("(或设置环境变量 RELAY_URL / RELAY_SECRET)");
  process.exit(1);
}

const identity = loadOrCreateIdentity();
const machineName = arg("name") || process.env.MACHINE_NAME || identity.machineName;

console.log(`[Tunnel] machineId=${identity.machineId} name=${machineName}`);
console.log(`[Tunnel] 隧道入口:<relay-http-origin>/t/${identity.machineId}/<本机端口>/`);

const handle = startTunnelClient({
  relayUrl,
  relaySecret,
  machineId: identity.machineId,
  machineName,
  onConnected: () => console.log("[Tunnel] Registered with relay."),
  onDisconnected: () => console.log("[Tunnel] Disconnected from relay; reconnecting..."),
});

const shutdown = () => {
  handle.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
```

`packages/tunnel-client/package.json` 顶层增加 `"bin": { "pocket-tunnel": "dist/cli.js" }`。
`packages/tunnel-client/src/index.ts` 追加 `export { loadOrCreateIdentity, type TunnelIdentity } from "./identity.js";`

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @pocket-code/tunnel-client test && pnpm --filter @pocket-code/tunnel-client build
node packages/tunnel-client/dist/cli.js 2>&1 | head -2
```

Expected: 测试全 PASS；CLI 无参运行打印用法并退出码 1。

- [ ] **Step 5: Commit**

```bash
git add packages/tunnel-client
git commit -m "feat(tunnel-client): pocket-tunnel CLI(身份持久化 ~/.pocket-tunnel.json+env/参数兜底,identity 测试 2 例)"
```

---

### Task 8: 端到端烟测（relay + tunnel-client 穿透，双场景）

**Files:**
- Create: `packages/relay/src/e2e.tunnel.test.ts`
- Modify: `packages/relay/package.json`（devDependencies 加 `"@pocket-code/tunnel-client": "workspace:*"`）

**Interfaces:**
- Consumes: Task 5 的 `startTunnelClient`；Task 3/4 的 RELAY_DISCOVERY/TUNNEL_TOKEN env。
- 验收语义（spec 第 6 节）：不装 daemon，仅 relay 进程 + tunnel-client 库即可 HTTP 穿透；DISCOVERY off 拒发现；TUNNEL_TOKEN 开启后无 token 404、带 token 通、cookie 续期通。

- [ ] **Step 1: 写 E2E 测试**

`packages/relay/src/e2e.tunnel.test.ts`：

```ts
// ── E2E:relay(子进程) + tunnel-client(进程内) 反向隧道穿透 ──
// 证明"不装 daemon 也能做隧道代理"。依赖 tsx(relay devDep)拉起 src/index.ts。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { createServer, type Server } from "http";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import WebSocket from "ws";
import { startTunnelClient, type TunnelClientHandle } from "@pocket-code/tunnel-client";

const here = dirname(fileURLToPath(import.meta.url));
const SECRET = "e2e-secret";
const TOKEN = "tok-e2e";

function randPort(): number {
  return 20000 + Math.floor(Math.random() * 20000);
}

async function waitHealthy(port: number, ms = 15000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() - t0 > ms) throw new Error(`relay :${port} not healthy in ${ms}ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function waitMachines(port: number, n: number, ms = 10000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const j = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    if (j.machines >= n) return;
    if (Date.now() - t0 > ms) throw new Error(`machines<${n} after ${ms}ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function spawnRelay(env: Record<string, string>): ChildProcess {
  const tsxBin = join(here, "..", "node_modules", ".bin", "tsx");
  const child = spawn(tsxBin, [join(here, "index.ts")], {
    env: { ...process.env, ...env },
    stdio: "ignore",
  });
  return child;
}

function startTarget(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`hello-tunnel:${req.url}`);
    });
    server.listen(0, () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0 });
    });
  });
}

describe("E2E: relay + tunnel-client 反向隧道", () => {
  describe("场景A: DISCOVERY=off,无 TUNNEL_TOKEN", () => {
    const relayPort = randPort();
    let relay: ChildProcess;
    let target: { server: Server; port: number };
    let client: TunnelClientHandle;

    beforeAll(async () => {
      relay = spawnRelay({ PORT: String(relayPort), RELAY_SECRET: SECRET, RELAY_DISCOVERY: "off" });
      await waitHealthy(relayPort);
      target = await startTarget();
      client = startTunnelClient({
        relayUrl: `ws://127.0.0.1:${relayPort}/relay`,
        relaySecret: SECRET,
        machineId: "m_e2e_a",
        machineName: "e2e-a",
      });
      await waitMachines(relayPort, 1);
    }, 30000);

    afterAll(() => {
      client?.stop();
      target?.server.close();
      relay?.kill();
    });

    it("HTTP 经隧道穿透取回目标响应(含 query)", async () => {
      const resp = await fetch(`http://127.0.0.1:${relayPort}/t/m_e2e_a/${target.port}/hello?x=1`);
      expect(resp.status).toBe(200);
      expect(await resp.text()).toBe("hello-tunnel:/hello?x=1");
    }, 15000);

    it("DISCOVERY off:list-machines 被拒", async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/relay`);
      const reply = await new Promise<any>((resolve, reject) => {
        ws.on("open", () => ws.send(JSON.stringify({ type: "list-machines" })));
        ws.on("message", (d: Buffer) => resolve(JSON.parse(d.toString())));
        ws.on("error", reject);
        setTimeout(() => reject(new Error("no reply")), 5000);
      });
      ws.close();
      expect(reply).toEqual({ type: "error", error: "Discovery is disabled on this relay" });
    }, 10000);
  });

  describe("场景B: TUNNEL_TOKEN 开启", () => {
    const relayPort = randPort();
    let relay: ChildProcess;
    let target: { server: Server; port: number };
    let client: TunnelClientHandle;

    beforeAll(async () => {
      relay = spawnRelay({ PORT: String(relayPort), RELAY_SECRET: SECRET, TUNNEL_TOKEN: TOKEN });
      await waitHealthy(relayPort);
      target = await startTarget();
      client = startTunnelClient({
        relayUrl: `ws://127.0.0.1:${relayPort}/relay`,
        relaySecret: SECRET,
        machineId: "m_e2e_b",
        machineName: "e2e-b",
      });
      await waitMachines(relayPort, 1);
    }, 30000);

    afterAll(() => {
      client?.stop();
      target?.server.close();
      relay?.kill();
    });

    it("无 token → 404;带 pc_token → 200 且种 pc_tunnel_token cookie", async () => {
      const denied = await fetch(`http://127.0.0.1:${relayPort}/t/m_e2e_b/${target.port}/`);
      expect(denied.status).toBe(404);

      const ok = await fetch(`http://127.0.0.1:${relayPort}/t/m_e2e_b/${target.port}/?pc_token=${TOKEN}`);
      expect(ok.status).toBe(200);
      expect(await ok.text()).toBe("hello-tunnel:/");
      expect(ok.headers.getSetCookie().join(";;")).toContain(`pc_tunnel_token=${TOKEN}`);
    }, 15000);

    it("cookie 路径:合法 token cookie 通过,错误 token 404", async () => {
      const ok = await fetch(`http://127.0.0.1:${relayPort}/sub.js`, {
        headers: { cookie: `pc_tunnel=m_e2e_b:${target.port}; pc_tunnel_token=${TOKEN}` },
      });
      expect(ok.status).toBe(200);
      expect(await ok.text()).toBe("hello-tunnel:/sub.js");

      const bad = await fetch(`http://127.0.0.1:${relayPort}/sub.js`, {
        headers: { cookie: `pc_tunnel=m_e2e_b:${target.port}; pc_tunnel_token=wrong` },
      });
      expect(bad.status).toBe(404);
    }, 15000);
  });
});
```

`packages/relay/package.json` devDependencies 增加 `"@pocket-code/tunnel-client": "workspace:*"`。

- [ ] **Step 2: 跑 E2E 确认通过**

```bash
pnpm install
pnpm --filter @pocket-code/tunnel-client build   # e2e 经 dist 解析 tunnel-client
pnpm --filter @pocket-code/relay test
```

Expected: E2E 4 例 PASS（首跑可能 10-20s）；relay 既有测试不回归。若端口偶发冲突（randPort 碰撞），重跑一次即可——不引入重试逻辑（YAGNI）。

- [ ] **Step 3: Commit**

```bash
git add packages/relay pnpm-lock.yaml
git commit -m "test(relay): E2E 烟测(relay 子进程+tunnel-client 穿透,DISCOVERY off/TUNNEL_TOKEN 双场景 4 例)"
```

---

### Task 9: 发布就绪件（README×2 + LICENSE + 包元数据）

**Files:**
- Create: `LICENSE`（仓库根，MIT）
- Create: `packages/relay/README.md`
- Create: `packages/tunnel-client/README.md`
- Modify: `packages/relay/package.json`、`packages/protocol-core/package.json`、`packages/tunnel-client/package.json`（元数据）
- Modify: `docs/deployment-relay-daemon.md`（头部加一行交叉引用）

**Interfaces:** 无代码接口；内容契约=spec 第 4/5 节（安全模型、轻通用化口吻、private 保持）。

- [ ] **Step 1: LICENSE（仓库根）**

```
MIT License

Copyright (c) 2026 worsher

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 2: 三包元数据**

三个 package.json 各自增加（description 按包）：

- relay：`"description": "Device pairing + message relay + HTTP/WS reverse tunnel server (ngrok-style, single-tenant shared-secret)"`
- protocol-core：`"description": "Business-agnostic relay protocol schemas: envelopes, pairing/discovery, tunnel frames, boundary unions (zod)"`
- tunnel-client：`"description": "Reverse-tunnel client for the pocket-code relay: registration, heartbeat, HTTP/WS tunnel frames + pocket-tunnel CLI"`

三包共同追加：

```json
  "license": "MIT",
  "repository": { "type": "git", "url": "https://github.com/worsher/pocket-code.git", "directory": "packages/<各自目录>" },
  "keywords": ["reverse-tunnel", "relay", "ngrok-alternative", "websocket"]
```

（`"private": true` 保持不动。）

- [ ] **Step 3: relay README**

`packages/relay/README.md`：

````markdown
# @pocket-code/relay

设备配对 + 消息中继 + HTTP/WS 反向隧道服务（类 ngrok，单租户共享密钥模型）。
零业务逻辑：只做鉴权、路由与隧道帧转发；协议定义见
[`@pocket-code/protocol-core`](../protocol-core)。内网侧客户端见
[`@pocket-code/tunnel-client`](../tunnel-client)（或 pocket-code daemon）。

## 架构

```
浏览器 ──HTTP/WS──► relay(公网) ◄──WS 控制连接── tunnel-client / daemon(内网)
   /t/<machineId>/<port>/...          │ daemon-register(HMAC) + heartbeat
   或 pc_tunnel cookie 路由            │ tunnel-request/response/chunk/end
                                      │ tunnel-ws-open/data/close(HMR)
App ──ws /relay──► relay ──forward──► daemon(配对/业务转发,可用 RELAY_DISCOVERY 关闭)
```

## 快速开始（纯隧道用法）

```bash
# 公网机:起 relay(强制共享密钥;纯隧道部署建议关闭发现与配对)
export RELAY_SECRET=$(openssl rand -hex 32)
export RELAY_DISCOVERY=off
export TUNNEL_TOKEN=$(openssl rand -hex 16)   # 强烈建议:隧道入口鉴权
pnpm --filter @pocket-code/relay build && node packages/relay/dist/index.js

# 内网机:起隧道客户端(同一 RELAY_SECRET)
pocket-tunnel --relay wss://your-host/relay --secret $RELAY_SECRET
# 输出 machineId 后,浏览器访问:
#   https://your-host/t/<machineId>/<本机端口>/?pc_token=<TUNNEL_TOKEN>
```

## 配置（env）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 3200 | 监听端口 |
| `RELAY_SECRET` | 必填 | 与所有 tunnel-client/daemon 共享的注册密钥（HMAC-SHA256） |
| `RELAY_DISCOVERY` | on | `off` 时拒绝 list-machines 与 pair-request 转发（纯隧道部署姿态） |
| `TUNNEL_TOKEN` | 关闭 | 设置后隧道入口强制鉴权：首次 `?pc_token=<值>`，校验通过种 `pc_tunnel_token` HttpOnly cookie；失败一律 404 |

## 安全模型（务必阅读）

分三层：

1. **端点注册与帧路由（强）**：注册走 `RELAY_SECRET` 的 HMAC 挑战（5 分钟时间窗防重放）；
   响应/隧道/心跳帧与注册身份绑定——连上也收不到、答不了别人机器的帧。
   这是**单租户共享密钥**设计：知道密钥即可注册端点，不适合直接多租户开放。
2. **传输**：TLS/wss 由前置反代（nginx）承担，见部署一节。
3. **浏览器侧隧道入口（默认弱，建议加固）**：未设 `TUNNEL_TOKEN` 时，
   `machineId`（64 位随机）就是唯一能力凭证——知道它即可浏览对应内网端口。
   它会出现在 URL/日志/浏览器历史中，请视为秘密；公网部署强烈建议设置
   `TUNNEL_TOKEN` 并配合 `RELAY_DISCOVERY=off`（否则任意 WS 连接可枚举在线 machineId）。

已知后置项（多用户/公开服务前必做）：per-machine 指纹（TOFU）、多租户隔离、
App→relay 连接鉴权。另注意目标页面外链的 Referer 可能泄漏含 machineId 的路径。

## 部署

生产部署（systemd/pm2 + nginx wss 终止）见仓库
[`docs/deployment-relay-daemon.md`](../../docs/deployment-relay-daemon.md)（relay 部分同样适用于纯隧道模式）。

## 协议

入站边界统一 `RelayInbound.safeParse`（zod）。信封 `payload` 为不透明对象——
relay 不认识业务协议，业务校验由隧道两端兜底。完整 schema 见
`packages/protocol-core/src/`（信封/配对/隧道帧/边界 union 四个文件即协议全文）。

## License

MIT
````

- [ ] **Step 4: tunnel-client README**

`packages/tunnel-client/README.md`：

````markdown
# @pocket-code/tunnel-client

pocket-code relay 的内网侧反向隧道客户端：注册（HMAC）、心跳、HTTP/WS 隧道帧转发。
附最小 CLI `pocket-tunnel`（tunnel-only：不含配对与 agent 业务，收到业务消息回明确错误帧）。

## CLI

```bash
pocket-tunnel --relay wss://your-host/relay --secret <RELAY_SECRET> [--name my-machine]
# env 兜底:RELAY_URL / RELAY_SECRET / MACHINE_NAME
# 身份持久化:~/.pocket-tunnel.json(首次生成 machineId,之后稳定复用)
```

启动后按输出的 machineId 访问：`https://your-host/t/<machineId>/<本机端口>/`
（relay 设置了 `TUNNEL_TOKEN` 时首次需带 `?pc_token=<值>`）。

## 库用法（嵌入宿主进程，如 pocket-code daemon）

```ts
import { startTunnelClient } from "@pocket-code/tunnel-client";

const handle = startTunnelClient({
  relayUrl: "wss://your-host/relay",
  relaySecret: process.env.RELAY_SECRET!,
  machineId: "m_xxxxxxxxxxxxxxxx",
  machineName: "my-box",
  // 可选:接管非隧道消息(pair-request/forward-request);不提供则回 tunnel-only 错误帧
  onMessage(msg, send) { /* 宿主业务 */ },
});
// handle.send(frame) / handle.stop()
```

隧道帧（tunnel-request、tunnel-ws-*）由包内自消化：HTTP 反代到 `localhost:<port>`，
WS 隧道对接本地 dev server（HMR 兼容，见 `src/tunnel.ts`）。断线自动指数退避重连。

## License

MIT
````

- [ ] **Step 5: 部署文档交叉引用**

`docs/deployment-relay-daemon.md` 标题下加一行：

```markdown
> 纯隧道部署（不跑 agent 业务）：relay 侧建议 `RELAY_DISCOVERY=off` + `TUNNEL_TOKEN`，内网侧用 `pocket-tunnel` CLI 替代 daemon——见 `packages/relay/README.md` 与 `packages/tunnel-client/README.md`。
```

- [ ] **Step 6: 验证与提交**

```bash
pnpm build   # package.json 改动后确认无破坏
git add LICENSE packages/relay/README.md packages/tunnel-client/README.md \
  packages/relay/package.json packages/protocol-core/package.json packages/tunnel-client/package.json \
  docs/deployment-relay-daemon.md
git commit -m "docs(relay,tunnel-client,protocol-core): 发布就绪件(README 安全模型/快速开始+LICENSE MIT+包元数据,保持 private)"
```

---

### Task 10: 收尾——plan.md 同步 + 全仓门禁

**Files:**
- Modify: `plan.md`（已完成表 + 拆分路线小节 relay 条目）
- Test: 全仓门禁

- [ ] **Step 1: plan.md 更新**

「已完成」表追加一行：

```markdown
| — | relay 拆分:protocol-core 拆层+tunnel-client(pocket-tunnel CLI)+发布就绪+DISCOVERY/TUNNEL_TOKEN 加固 | specs+plans/2026-07-10-relay拆分 |
```

「拆分路线」小节中 relay 一行替换为：

```markdown
- **relay** → 已达"随时可迁"终态(specs/2026-07-10-relay拆分):依赖图自足(protocol-core+ws)、发布件齐、隧道入口可鉴权;真正开源仅剩 git subtree 迁移+npm 发布。
```

「安全后置」小节首行 `App→relay 连接鉴权（list-machines 当前对任意连接可见）` 追加说明：

```markdown
- App→relay 连接鉴权（list-machines 对任意连接可见;纯隧道部署可用 `RELAY_DISCOVERY=off` 整体关闭,自用部署维持现状）
```

- [ ] **Step 2: 全仓门禁**

```bash
pnpm build && pnpm test:all && pnpm typecheck:app
```

Expected: 全绿（wire 减少的用例数由 protocol-core 补回并新增；relay 新增 DISCOVERY/TUNNEL_TOKEN/E2E 用例；tunnel-client 新包用例入列；app 71 例不回归）。

- [ ] **Step 3: Commit**

```bash
git add plan.md
git commit -m "docs: relay 拆分完成态同步(plan.md 已完成表+拆分路线 relay 终态+安全后置注记)"
```

---

### Task 11: 手动验收指引（用户执行，非 agent 步骤）

本任务无代码。执行完 Task 10 后向用户提供以下验收清单（真机/VPS 环境）：

1. VPS 更新 relay（`pnpm --filter @pocket-code/relay build` + 重启），先**不设**新 env——确认 App 配对/对话/预览与升级前行为一致（默认值兼容性）。
2. 内网任意机器 `pocket-tunnel --relay wss://<vps>/relay --secret $RELAY_SECRET`，起一个本地 dev server，浏览器走 `/t/<id>/<port>/` 确认穿透（含 vite HMR 页面）。
3. relay 加 `TUNNEL_TOKEN` 重启：无 token 访问 404，带 `?pc_token=` 一次后续页内资源正常。
4. 纯隧道姿态演练：`RELAY_DISCOVERY=off` 重启，确认 App 的机器发现/配对被明确拒绝（提示语），隧道不受影响；恢复 on 后 App 流程复原。

---

## Self-Review 记录

- **Spec 覆盖**：§2 protocol-core(Task 1-2)、§3 tunnel-client(Task 5-7)、§4.1 DISCOVERY(Task 3)、§4.2 TUNNEL_TOKEN(Task 4)、§5 发布件(Task 9)、§6 测试与验收(各 task TDD+Task 8 E2E+Task 10 门禁+Task 11 人工)、§7 非目标未越界、§8 拆分路线(Task 10 plan.md)。无缺口。
- **占位符**：无 TBD/TODO；所有代码步骤含完整代码；迁移步骤以"复制+精确差异清单"表达（与 P10 已验证的模式一致）。
- **类型一致性**：`HttpRouterDeps`/`UpgradeDeps.tunnelToken`/`RouterDeps.discovery` 在 Task 3/4/8 引用一致；`TunnelClientOptions`/`TunnelClientHandle`/`handleTunnelClientMessage` 在 Task 5/6/7/8 引用一致；`loadOrCreateIdentity` 签名 Task 7 定义与测试一致；protocol-core 导出清单与 Task 2 wire re-export 清单逐符号一致。
- **顺序依赖**：Task 2 依赖 Task 1;Task 4 依赖 Task 3(config 模式);Task 6 依赖 Task 5;Task 8 依赖 Task 3/4/5;其余独立。E2E 经 dist 解析 tunnel-client——门禁顺序 build→test 已在 Global Constraints 声明。
