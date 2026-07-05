import { describe, it, expect } from "vitest";
import { parseRelayMessage } from "./inbound.js";

describe("parseRelayMessage", () => {
  it("parses valid relay messages", () => {
    expect(parseRelayMessage(JSON.stringify({ type: "daemon-registered", machineId: "m_1" }))?.type)
      .toBe("daemon-registered");
    expect(parseRelayMessage(JSON.stringify({
      type: "forward-request", token: "jwt", requestId: "r1", payload: { type: "abort" },
    }))?.type).toBe("forward-request");
    expect(parseRelayMessage(JSON.stringify({
      type: "tunnel-request", tunnelId: "t1", port: 5173, method: "GET", path: "/", headers: {},
    }))?.type).toBe("tunnel-request");
    expect(parseRelayMessage(JSON.stringify({ type: "error", error: "boom" }))?.type).toBe("error");
  });

  it("returns null for malformed input without throwing (畸形消息安全忽略)", () => {
    expect(parseRelayMessage("not json{")).toBeNull();
    expect(parseRelayMessage(JSON.stringify({ type: "hack" }))).toBeNull();
    expect(parseRelayMessage(JSON.stringify({ type: "forward-request", requestId: "r1" }))).toBeNull(); // 缺 token/payload
    expect(parseRelayMessage(JSON.stringify({
      type: "tunnel-request", tunnelId: "t1", port: 99999, method: "GET", path: "/", headers: {},
    }))).toBeNull(); // 端口越界
  });
});
