import { describe, it, expect, vi } from "vitest";
import { WsTunnelHub } from "./wsTunnelHub.js";

/** 最小浏览器侧 ws mock:可注册事件、记录 send/close */
function mockBrowserWs() {
  const listeners = new Map<string, Function[]>();
  return {
    readyState: 1,
    sent: [] as any[],
    closed: null as null | { code?: number; reason?: string },
    on(ev: string, cb: Function) {
      listeners.set(ev, [...(listeners.get(ev) || []), cb]);
    },
    emit(ev: string, ...args: any[]) {
      for (const cb of listeners.get(ev) || []) cb(...args);
    },
    send(data: any) { this.sent.push(data); },
    close(code?: number, reason?: string) {
      this.closed = { code, reason };
      this.emit("close", code ?? 1005, Buffer.from(reason ?? ""));
    },
    terminate() { this.closed = { code: 1006 }; },
  };
}

describe("WsTunnelHub", () => {
  it("buffers browser messages until opened, then flushes to daemon", () => {
    const toDaemon = vi.fn(() => true);
    const hub = new WsTunnelHub(toDaemon);
    const ws = mockBrowserWs();
    hub.open("ws_1", ws as any, "m_A");

    ws.emit("message", Buffer.from("early"), false);
    expect(toDaemon).not.toHaveBeenCalled(); // opened 前缓冲

    hub.onOpened("ws_1", "m_A");
    expect(toDaemon).toHaveBeenCalledWith("m_A", {
      type: "tunnel-ws-data", tunnelId: "ws_1", data: "early",
    });

    ws.emit("message", Buffer.from([9]), true); // opened 后直发,二进制
    const lastCall = toDaemon.mock.calls.at(-1) as any;
    const lastFrame = lastCall[1] as any;
    expect(lastFrame.binary).toBe(true);
    expect(Buffer.from(lastFrame.data, "base64")).toEqual(Buffer.from([9]));
  });

  it("closes the tunnel when pre-open buffer exceeds 64 messages", () => {
    const toDaemon = vi.fn((_machineId: string, _frame: unknown) => true);
    const hub = new WsTunnelHub(toDaemon);
    const ws = mockBrowserWs();
    hub.open("ws_2", ws as any, "m_A");
    for (let i = 0; i < 65; i++) ws.emit("message", Buffer.from("x"), false);
    expect(ws.closed?.code).toBe(1011);
    expect(hub.size).toBe(0);
    // daemon 必须收到 close 通知(否则其本地连接泄漏)
    const closeFrames = toDaemon.mock.calls.filter((c) => (c[1] as any).type === "tunnel-ws-close");
    expect(closeFrames).toHaveLength(1);
    expect((closeFrames[0][1] as any).code).toBe(1011);
  });

  it("writes daemon data frames to browser ws and drops frames from non-owner", () => {
    const hub = new WsTunnelHub(() => true);
    const ws = mockBrowserWs();
    hub.open("ws_3", ws as any, "m_A");
    hub.onOpened("ws_3", "m_A");

    hub.onData("ws_3", "hello", undefined, "m_B"); // 伪造者 → 丢弃
    expect(ws.sent).toHaveLength(0);

    hub.onData("ws_3", "hello", undefined, "m_A");
    expect(ws.sent[0]).toBe("hello");
    hub.onData("ws_3", Buffer.from([1]).toString("base64"), true, "m_A");
    expect(Buffer.isBuffer(ws.sent[1])).toBe(true);
  });

  it("onClose clamps illegal codes and does not echo a close frame back", () => {
    const toDaemon = vi.fn(() => true);
    const hub = new WsTunnelHub(toDaemon);
    const ws = mockBrowserWs();
    hub.open("ws_4", ws as any, "m_A");
    hub.onOpened("ws_4", "m_A");
    toDaemon.mockClear();

    hub.onClose("ws_4", 1006, "abnormal", "m_A"); // 1006 → 夹紧 1000
    expect(ws.closed?.code).toBe(1000);
    // 浏览器 close 事件触发后不应再回发 close 帧(隧道已删)
    expect(toDaemon).not.toHaveBeenCalled();
  });

  it("browser-initiated close sends close frame to daemon once", () => {
    const toDaemon = vi.fn(() => true);
    const hub = new WsTunnelHub(toDaemon);
    const ws = mockBrowserWs();
    hub.open("ws_5", ws as any, "m_A");
    hub.onOpened("ws_5", "m_A");
    toDaemon.mockClear();

    ws.emit("close", 1001, Buffer.from("navigate away"));
    expect(toDaemon).toHaveBeenCalledTimes(1);
    const closeCall = toDaemon.mock.calls[0] as any;
    expect((closeCall[1] as any).type).toBe("tunnel-ws-close");
    expect(hub.size).toBe(0);
  });

  it("abortByMachine only closes that machine's tunnels", () => {
    const hub = new WsTunnelHub(() => true);
    const a = mockBrowserWs();
    const b = mockBrowserWs();
    hub.open("ws_a", a as any, "m_A");
    hub.open("ws_b", b as any, "m_B");
    hub.abortByMachine("m_A");
    expect(a.closed?.code).toBe(1001);
    expect(b.closed).toBeNull();
    expect(hub.size).toBe(1);
  });
});
