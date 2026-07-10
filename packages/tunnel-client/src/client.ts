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
