import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServerConnection, type ConnectionConfig, type ConnectionHandlers } from "./serverConnection";

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CLOSED;
  sent: string[] = [];
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
  /** 测试辅助:模拟服务端握手完成 */
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  receive(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

/** 测试辅助:如真实 WebSocket 一样,onclose 触发前 readyState 已是 CLOSED */
function closeSocket(ws: FakeWebSocket) {
  ws.readyState = FakeWebSocket.CLOSED;
  ws.onclose?.();
}

function makeConfig(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    getServerUrl: () => "ws://localhost:8787",
    isRelayMode: () => false,
    getRelayOptions: () => ({ machineId: "", deviceId: "d_1" }),
    getAuthToken: () => undefined,
    getDeviceId: () => "d_1",
    buildInitPayload: () => ({ sessionId: undefined }),
    isRelayPaired: () => false,
    ...overrides,
  };
}

function makeHandlers(overrides: Partial<ConnectionHandlers> = {}): ConnectionHandlers {
  return {
    onAgentEvent: () => {},
    onAuth: () => {},
    onSession: () => {},
    onConnected: () => {},
    onDisconnected: () => {},
    onAuthError: () => {},
    onFileChanged: () => {},
    ...overrides,
  };
}

describe("ServerConnection", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("registers with deviceId on open when no auth token (LAN mode)", () => {
    const conn = new ServerConnection(makeConfig(), makeHandlers());
    conn.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    expect(JSON.parse(ws.sent[0])).toEqual({ type: "register", deviceId: "d_1" });
    conn.disconnect();
  });

  it("sends init with token+payload after auth message and forwards onAuth", () => {
    const auths: Array<[string, string]> = [];
    const conn = new ServerConnection(
      makeConfig(),
      makeHandlers({ onAuth: (t, u) => auths.push([t, u]) })
    );
    conn.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.receive({ type: "auth", token: "tok_1", userId: "u_1" });
    expect(auths).toEqual([["tok_1", "u_1"]]);
    const init = JSON.parse(ws.sent[1]);
    expect(init.type).toBe("init");
    expect(init.token).toBe("tok_1");
    conn.disconnect();
  });

  it("resolves listFiles via _reqId and rejects on timeout", async () => {
    vi.useFakeTimers();
    const conn = new ServerConnection(makeConfig(), makeHandlers());
    conn.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();

    const p1 = conn.listFiles("src");
    const sent = JSON.parse(ws.sent.at(-1)!);
    expect(sent.type).toBe("list-files");
    ws.receive({ type: "file-list", path: "src", _reqId: sent._reqId, success: true, items: [] });
    await expect(p1).resolves.toMatchObject({ success: true, items: [] });

    const p2 = conn.listFiles("src");
    const rejected = expect(p2).rejects.toThrow("File list timed out");
    vi.advanceTimersByTime(10_001);
    await rejected;
    conn.disconnect();
  });

  it("routes normalized agent events to onAgentEvent", () => {
    const events: string[] = [];
    const conn = new ServerConnection(
      makeConfig(),
      makeHandlers({ onAgentEvent: (ev) => events.push(ev.type) })
    );
    conn.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.receive({ type: "text-delta", text: "hi" });
    ws.receive({ type: "done" });
    expect(events).toEqual(["text-delta", "done"]);
    conn.disconnect();
  });

  it("stops reconnecting and calls onAuthError on Unauthorized error", () => {
    vi.useFakeTimers();
    let authError = "";
    const conn = new ServerConnection(
      makeConfig(),
      makeHandlers({ onAuthError: (m) => (authError = m) })
    );
    conn.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.receive({ type: "error", error: "Unauthorized device" });
    expect(authError).toContain("重新配对");
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1); // 未重连
  });

  it("reconnects with exponential backoff after unexpected close", () => {
    vi.useFakeTimers();
    const conn = new ServerConnection(makeConfig(), makeHandlers());
    conn.connect();
    FakeWebSocket.instances[0].open();
    closeSocket(FakeWebSocket.instances[0]); // 意外断开
    vi.advanceTimersByTime(2_000); // 第 1 次退避 2s
    expect(FakeWebSocket.instances).toHaveLength(2);
    closeSocket(FakeWebSocket.instances[1]);
    vi.advanceTimersByTime(3_999);
    expect(FakeWebSocket.instances).toHaveLength(2); // 第 2 次退避 4s,未到
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(3);
    conn.disconnect();
  });

  describe("onTokenPersist 透传", () => {
    it("relay 模式下把 config.onTokenPersist 透传给 RelayClient(updateToken 触发宿主回调)", () => {
      const persist = vi.fn();
      const conn = new ServerConnection(
        makeConfig({
          isRelayMode: () => true,
          getRelayOptions: () => ({ machineId: "m_1", deviceId: "d_1", token: "tok_0" }),
          onTokenPersist: persist,
        }),
        makeHandlers()
      );
      conn.connect();
      // connect() 在 relay 模式下创建 RelayClient(私有 ws 字段)。
      // 经其公共 API updateToken 断言回调被透传(行为断言,不翻私有 opts)。
      const relay = (conn as unknown as { ws: { updateToken(t: string, m: string): void } }).ws;
      relay.updateToken("tok_1", "m_1");
      expect(persist).toHaveBeenCalledWith("tok_1", "m_1");
    });
  });
});
