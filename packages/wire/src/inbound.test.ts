import { describe, it, expect } from "vitest";
import { RelayInbound, DaemonInbound, RelayErrorMessage, DaemonRegistered } from "./inbound.js";

describe("RelayInbound", () => {
  const valid: unknown[] = [
    { type: "daemon-register", machineId: "m_1", machineName: "Mac", authToken: "ab", timestamp: 1 },
    { type: "daemon-heartbeat", machineId: "m_1", timestamp: 1 },
    { type: "forward-response", requestId: "r1", payload: { type: "done" } },
    { type: "forward-stream", requestId: "r1", payload: { type: "text-delta", text: "x" } },
    { type: "pair-response", success: true, token: "t", machineId: "m_1", machineName: "Mac" },
    { type: "pair-response", success: false, error: "bad code" },
    { type: "tunnel-response", tunnelId: "t1", status: 200, headers: {} },
    { type: "tunnel-chunk", tunnelId: "t1", data: "YWJj" },
    { type: "tunnel-end", tunnelId: "t1" },
    { type: "tunnel-ws-opened", tunnelId: "ws_1" },
    { type: "tunnel-ws-data", tunnelId: "ws_1", data: "x" },
    { type: "tunnel-ws-close", tunnelId: "ws_1", code: 1000 },
    { type: "list-machines" },
    { type: "pair-request", pairingCode: "ABCD2345", deviceId: "d1", deviceName: "Phone" },
    { type: "relay-request", token: "jwt", machineId: "m_1", requestId: "r1", payload: { type: "abort" } },
  ];
  it.each(valid.map((v) => [(v as any).type, v]))("accepts %s", (_t, v) => {
    expect(RelayInbound.safeParse(v).success).toBe(true);
  });

  it("rejects unknown type / missing fields / bad payload", () => {
    expect(RelayInbound.safeParse({ type: "nope" }).success).toBe(false);
    expect(RelayInbound.safeParse({ type: "daemon-register", machineId: "m_1" }).success).toBe(false); // 缺 machineName
    expect(RelayInbound.safeParse({ type: "relay-request", token: "j", machineId: "m", requestId: "r", payload: { type: "not-a-real-type" } }).success).toBe(false);
    expect(RelayInbound.safeParse("not an object").success).toBe(false);
  });
});

describe("DaemonInbound", () => {
  const valid: unknown[] = [
    { type: "daemon-registered", machineId: "m_1" },
    { type: "pair-request", pairingCode: "ABCD2345", deviceId: "d1", deviceName: "Phone" },
    { type: "forward-request", token: "jwt", requestId: "r1", payload: { type: "abort" } },
    { type: "tunnel-request", tunnelId: "t1", port: 5173, method: "GET", path: "/", headers: {} },
    { type: "tunnel-ws-open", tunnelId: "ws_1", port: 5173, path: "/", headers: {} },
    { type: "tunnel-ws-data", tunnelId: "ws_1", data: "x", binary: true },
    { type: "tunnel-ws-close", tunnelId: "ws_1" },
    { type: "error", error: "boom" },
  ];
  it.each(valid.map((v) => [(v as any).type, v]))("accepts %s", (_t, v) => {
    expect(DaemonInbound.safeParse(v).success).toBe(true);
  });

  it("rejects unknown type and malformed frames", () => {
    expect(DaemonInbound.safeParse({ type: "machines-list", machines: [] }).success).toBe(false);
    expect(DaemonInbound.safeParse({ type: "tunnel-request", tunnelId: "t1", port: 99999, method: "GET", path: "/", headers: {} }).success).toBe(false); // 端口越界
  });
});

describe("standalone schemas", () => {
  it("RelayErrorMessage / DaemonRegistered round-trip", () => {
    expect(RelayErrorMessage.safeParse({ type: "error", error: "x" }).success).toBe(true);
    expect(DaemonRegistered.safeParse({ type: "daemon-registered", machineId: "m" }).success).toBe(true);
    expect(DaemonRegistered.safeParse({ type: "daemon-registered" }).success).toBe(false);
  });
});
