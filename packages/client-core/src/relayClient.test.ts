import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RelayClient } from "./relayClient";

describe("RelayClient", () => {
  class FakeWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    static instances: FakeWebSocket[] = [];
    readyState = FakeWebSocket.CLOSED;
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose?: (event: { code: number; reason: string }) => void;
    onerror?: () => void;

    constructor(public url: string) {
      FakeWebSocket.instances.push(this);
    }

    send() {}
    close() {}
  }

  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function makeClient(relayUrl: string, machineId = "m_1") {
    return new RelayClient({
      relayUrl,
      machineId,
      deviceId: "d_1",
      deviceName: "Pocket Code App",
      token: "token",
    });
  }

  function openedUrls(): string[] {
    return FakeWebSocket.instances.map((s) => s.url);
  }

  it("normalizes https relay URLs to wss before opening WebSocket", () => {
    makeClient("https://aigc.zj.cn/relay").connect();
    expect(openedUrls()).toEqual(["wss://aigc.zj.cn/relay"]);
  });

  it("uses the /relay control path when only a relay origin is configured", () => {
    makeClient("wss://aigc.zj.cn").connect();
    expect(openedUrls()).toEqual(["wss://aigc.zj.cn/relay"]);
  });

  it("strips trailing slashes so /relay/ still hits the relay control path", () => {
    makeClient("wss://aigc.zj.cn/relay/").connect();
    expect(openedUrls()).toEqual(["wss://aigc.zj.cn/relay"]);
  });

  it("rejects pending pairing when relay returns an error", async () => {
    vi.useFakeTimers();
    const client = makeClient("wss://aigc.zj.cn/relay", "");
    client.connect();

    const socket = FakeWebSocket.instances[0];
    socket.readyState = FakeWebSocket.OPEN;
    const pairing = client.pairDevice("ABCD2345");
    const assertion = expect(pairing).rejects.toThrow("Invalid message: pair-request");
    socket.onmessage?.({ data: JSON.stringify({ type: "error", error: "Invalid message: pair-request" }) });

    await assertion;
  });

  it("rejects pending pairing immediately when the socket closes", async () => {
    const client = makeClient("wss://aigc.zj.cn/relay", "");
    client.connect();

    const socket = FakeWebSocket.instances[0];
    socket.readyState = FakeWebSocket.OPEN;
    const pairing = client.pairDevice("ABCD2345");
    const assertion = expect(pairing).rejects.toThrow("closed");
    socket.onclose?.({ code: 1006, reason: "" });

    await assertion;
  });

  it("invokes onTokenPersist instead of touching any store on updateToken", () => {
    const persisted: Array<[string, string]> = [];
    const client = new RelayClient({
      relayUrl: "wss://aigc.zj.cn/relay",
      machineId: "",
      deviceId: "d_1",
      deviceName: "Pocket Code Web",
      onTokenPersist: (token, machineId) => persisted.push([token, machineId]),
    });
    client.updateToken("tok_1", "m_1");
    expect(persisted).toEqual([["tok_1", "m_1"]]);
  });
});
