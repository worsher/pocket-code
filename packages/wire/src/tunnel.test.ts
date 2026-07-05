import { describe, it, expect } from "vitest";
import { TunnelFrame, TunnelWsOpen, TunnelWsOpened, TunnelWsData, TunnelWsClose } from "./tunnel.js";

describe("wire — TunnelFrame", () => {
  it("accepts tunnel-request", () => {
    const r = TunnelFrame.safeParse({
      type: "tunnel-request",
      tunnelId: "t1",
      port: 3000,
      method: "GET",
      path: "/index.html",
      headers: { accept: "text/html" },
    });
    expect(r.success).toBe(true);
  });

  it("accepts tunnel-response / chunk / end", () => {
    expect(
      TunnelFrame.safeParse({ type: "tunnel-response", tunnelId: "t1", status: 200, headers: {} }).success
    ).toBe(true);
    expect(TunnelFrame.safeParse({ type: "tunnel-chunk", tunnelId: "t1", data: "YWJj" }).success).toBe(true);
    expect(TunnelFrame.safeParse({ type: "tunnel-end", tunnelId: "t1" }).success).toBe(true);
    expect(TunnelFrame.safeParse({ type: "tunnel-end", tunnelId: "t1", error: "boom" }).success).toBe(true);
  });

  it("rejects tunnel-request with invalid port", () => {
    expect(
      TunnelFrame.safeParse({ type: "tunnel-request", tunnelId: "t1", port: 0, method: "GET", path: "/", headers: {} }).success
    ).toBe(false);
  });

  it("rejects unknown frame type", () => {
    expect(TunnelFrame.safeParse({ type: "tunnel-foo", tunnelId: "t1" }).success).toBe(false);
  });

  describe("WS tunnel frames (P7 HMR)", () => {
    it("accepts the four ws-tunnel frames", () => {
      expect(TunnelWsOpen.safeParse({
        type: "tunnel-ws-open", tunnelId: "ws_1", port: 5173, path: "/",
        headers: { cookie: "pc_tunnel=m:5173", "sec-websocket-protocol": "vite-hmr" },
      }).success).toBe(true);
      expect(TunnelWsOpened.safeParse({ type: "tunnel-ws-opened", tunnelId: "ws_1", protocol: "vite-hmr" }).success).toBe(true);
      expect(TunnelWsOpened.safeParse({ type: "tunnel-ws-opened", tunnelId: "ws_1" }).success).toBe(true);
      expect(TunnelWsData.safeParse({ type: "tunnel-ws-data", tunnelId: "ws_1", data: "{\"type\":\"update\"}" }).success).toBe(true);
      expect(TunnelWsData.safeParse({ type: "tunnel-ws-data", tunnelId: "ws_1", data: "AAEC", binary: true }).success).toBe(true);
      expect(TunnelWsClose.safeParse({ type: "tunnel-ws-close", tunnelId: "ws_1", code: 1000, reason: "done" }).success).toBe(true);
    });
    it("rejects malformed ws-tunnel frames", () => {
      expect(TunnelWsOpen.safeParse({ type: "tunnel-ws-open", tunnelId: "ws_1", port: 99999, path: "/", headers: {} }).success).toBe(false);
      expect(TunnelWsData.safeParse({ type: "tunnel-ws-data", tunnelId: "ws_1" }).success).toBe(false); // 缺 data
      expect(TunnelWsClose.safeParse({ type: "tunnel-ws-close" }).success).toBe(false); // 缺 tunnelId
    });
    it("TunnelFrame union covers all eight members", () => {
      expect(TunnelFrame.safeParse({ type: "tunnel-ws-open", tunnelId: "t", port: 1, path: "/", headers: {} }).success).toBe(true);
      expect(TunnelFrame.safeParse({ type: "tunnel-ws-close", tunnelId: "t" }).success).toBe(true);
    });
  });
});
