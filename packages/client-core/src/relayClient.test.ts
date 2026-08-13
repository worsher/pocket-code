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

    sent: string[] = [];
    send(data: string) {
      this.sent.push(data);
    }
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

  it("uses turnId as the Relay request id so reconnects can rebind the stream", () => {
    const client = makeClient("wss://aigc.zj.cn/relay");
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket.readyState = FakeWebSocket.OPEN;
    expect(
      client.send(JSON.stringify({ type: "message", turnId: "turn-1", content: "hello" }))
    ).toBe(true);
    expect(JSON.parse(socket.sent[0]).requestId).toBe("turn-1");

    expect(
      client.send(
        JSON.stringify({ type: "goal-control", action: "resume", turnId: "turn-goal-resume" })
      )
    ).toBe(true);
    expect(JSON.parse(socket.sent[1]).requestId).toBe("turn-goal-resume");
  });

  it("reports unsent envelopes instead of silently accepting them", () => {
    const unpaired = makeClient("wss://aigc.zj.cn/relay", "");
    unpaired.connect();
    const socket = FakeWebSocket.instances[0];
    socket.readyState = FakeWebSocket.OPEN;
    expect(unpaired.send(JSON.stringify({ type: "message", content: "hello" }))).toBe(false);

    const paired = makeClient("wss://aigc.zj.cn/relay");
    paired.connect();
    const throwingSocket = FakeWebSocket.instances[1];
    throwingSocket.readyState = FakeWebSocket.OPEN;
    throwingSocket.send = () => {
      throw new Error("write failed");
    };
    expect(paired.send(JSON.stringify({ type: "message", content: "hello" }))).toBe(false);
  });

  it("correlates Relay control errors back to the originating turn", () => {
    const client = makeClient("wss://aigc.zj.cn/relay");
    const received: any[] = [];
    client.onmessage = (event) => received.push(JSON.parse(event.data));
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket.onmessage?.({
      data: JSON.stringify({
        type: "relay-response",
        requestId: "turn-1",
        payload: { type: "error", error: "Daemon m_1 is not online." },
      }),
    });
    expect(received).toEqual([
      { type: "error", error: "Daemon m_1 is not online.", turnId: "turn-1" },
    ]);
  });

  it("rejects pending pairing when relay returns an error", async () => {
    vi.useFakeTimers();
    const client = makeClient("wss://aigc.zj.cn/relay", "");
    client.connect();

    const socket = FakeWebSocket.instances[0];
    socket.readyState = FakeWebSocket.OPEN;
    const pairing = client.pairDevice("ABCD2345");
    const assertion = expect(pairing).rejects.toThrow("Invalid message: pair-request");
    socket.onmessage?.({
      data: JSON.stringify({ type: "error", error: "Invalid message: pair-request" }),
    });

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

  it("TOFU-pins the daemon encryption key returned by authenticated pairing", async () => {
    vi.useFakeTimers();
    const persisted: unknown[] = [];
    const client = new RelayClient({
      relayUrl: "wss://aigc.zj.cn/relay",
      machineId: "",
      deviceId: "d_1",
      deviceName: "Pocket Code App",
      onEncryptionKeyPersist: (key, machineId) => persisted.push({ key, machineId }),
    });
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket.readyState = FakeWebSocket.OPEN;
    const pairing = client.pairDevice("ABCD2345");
    socket.onmessage?.({
      data: JSON.stringify({
        type: "pair-response",
        success: true,
        token: "token",
        machineId: "m_1",
        machineName: "Mac",
        publicKey: "public-key",
        keyId: "key-1",
      }),
    });
    await expect(pairing).resolves.toMatchObject({ keyId: "key-1" });
    expect(persisted).toEqual([
      { key: { publicKey: "public-key", keyId: "key-1" }, machineId: "m_1" },
    ]);
  });

  it("rejects a pairing response that changes a pinned daemon key", async () => {
    vi.useFakeTimers();
    const client = new RelayClient({
      relayUrl: "wss://aigc.zj.cn/relay",
      machineId: "",
      deviceId: "d_1",
      deviceName: "Pocket Code App",
      pinnedEncryptionKey: { publicKey: "old-public-key", keyId: "old-key" },
    });
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket.readyState = FakeWebSocket.OPEN;
    const pairing = client.pairDevice("ABCD2345");
    const assertion = expect(pairing).rejects.toThrow("encryption key changed");
    socket.onmessage?.({
      data: JSON.stringify({
        type: "pair-response",
        success: true,
        token: "token",
        machineId: "m_1",
        machineName: "Mac",
        publicKey: "new-public-key",
        keyId: "new-key",
      }),
    });
    await assertion;
  });
});
