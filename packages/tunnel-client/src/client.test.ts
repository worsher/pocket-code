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
