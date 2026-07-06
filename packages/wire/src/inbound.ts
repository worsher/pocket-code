// ── 边界入站消息联合(relay / daemon 各自收到的一切) ─────────────
// P6a:让 relay 与 daemon 在消息边界 safeParse,替代裸 JSON.parse + 手工字段检查。
// 用 z.union 而非 discriminatedUnion:PairResponse 的判别键是 success 而非 type。

import { z } from "zod";
import {
  DaemonRegister,
  DaemonHeartbeat,
  ListMachines,
  PairRequest,
  PairResponse,
} from "./pairing.js";
import {
  RelayRequest,
  ForwardRequest,
  ForwardResponse,
  ForwardStream,
} from "./relay.js";
import { TunnelRequest, TunnelResponse, TunnelChunk, TunnelEnd, TunnelWsOpen, TunnelWsOpened, TunnelWsData, TunnelWsClose } from "./tunnel.js";

/** relay → daemon / relay → app 的通用错误消息 */
export const RelayErrorMessage = z.object({
  type: z.literal("error"),
  error: z.string(),
});
export type RelayErrorMessageType = z.infer<typeof RelayErrorMessage>;

/** relay → daemon:注册确认 */
export const DaemonRegistered = z.object({
  type: z.literal("daemon-registered"),
  machineId: z.string().min(1).max(128),
});
export type DaemonRegisteredType = z.infer<typeof DaemonRegistered>;

/** relay 收到的一切消息(daemon 侧 + app 侧) */
export const RelayInbound = z.union([
  DaemonRegister,
  DaemonHeartbeat,
  ForwardResponse,
  ForwardStream,
  PairResponse,
  TunnelResponse,
  TunnelChunk,
  TunnelEnd,
  TunnelWsOpened,
  TunnelWsData,
  TunnelWsClose,
  ListMachines,
  PairRequest,
  RelayRequest,
]);
export type RelayInboundType = z.infer<typeof RelayInbound>;

/** daemon 收到的一切消息(均来自 relay) */
export const DaemonInbound = z.union([
  DaemonRegistered,
  PairRequest,
  ForwardRequest,
  TunnelRequest,
  TunnelWsOpen,
  TunnelWsData,
  TunnelWsClose,
  RelayErrorMessage,
]);
export type DaemonInboundType = z.infer<typeof DaemonInbound>;
