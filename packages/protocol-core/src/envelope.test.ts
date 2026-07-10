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
