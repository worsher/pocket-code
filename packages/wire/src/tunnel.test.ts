import { describe, it, expect } from "vitest";
import { TunnelFrame } from "./tunnel.js";

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
});
