import { describe, it, expect, vi, afterEach } from "vitest";
import crypto from "crypto";
import type { WebSocket } from "ws";
import { createConnState, handleRelayInbound, type RouterDeps } from "./messageRouter.js";
import { RequestTracker } from "./requestTracker.js";
import { TunnelHub } from "./tunnelHub.js";
import { WsTunnelHub } from "./wsTunnelHub.js";
import { unregisterDaemon, getOnlineMachines } from "./relay.js";

const SECRET = "test-secret";

class MockWs {
  readyState = 1; // OPEN
  sent: any[] = [];
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
}
const asWs = (m: MockWs) => m as unknown as WebSocket;

function makeDeps(): RouterDeps {
  return { relaySecret: SECRET, requests: new RequestTracker(), tunnelHub: new TunnelHub(), wsTunnelHub: new WsTunnelHub(() => true) };
}

function hmac(machineId: string, ts: number, secret = SECRET) {
  return crypto.createHmac("sha256", secret).update(machineId + ts).digest("hex");
}

/** 注册一个 daemon,返回其 socket 与连接状态 */
function registerDaemonVia(deps: RouterDeps, machineId: string) {
  const ws = new MockWs();
  const state = createConnState();
  const ts = Date.now();
  handleRelayInbound(asWs(ws), JSON.stringify({
    type: "daemon-register", machineId, machineName: "M-" + machineId,
    authToken: hmac(machineId, ts), timestamp: ts,
  }), state, deps);
  return { ws, state };
}

// relay.js 的 daemons 是模块级全局,逐例清理
const cleanups: MockWs[] = [];
afterEach(() => {
  for (const ws of cleanups.splice(0)) unregisterDaemon(asWs(ws));
});

describe("registration (强制鉴权)", () => {
  it("registers a daemon with valid HMAC and confirms", () => {
    const deps = makeDeps();
    const { ws, state } = registerDaemonVia(deps, "m_reg1");
    cleanups.push(ws);
    expect(state.role).toBe("daemon");
    expect(state.machineId).toBe("m_reg1");
    expect(ws.sent.at(-1)).toEqual({ type: "daemon-registered", machineId: "m_reg1" });
    expect(getOnlineMachines().some((m) => m.machineId === "m_reg1")).toBe(true);
  });

  it("rejects registration without authToken", () => {
    const deps = makeDeps();
    const ws = new MockWs();
    const state = createConnState();
    handleRelayInbound(asWs(ws), JSON.stringify({
      type: "daemon-register", machineId: "m_anon", machineName: "Evil",
    }), state, deps);
    expect(state.role).toBe("unknown");
    expect(ws.sent.at(-1).type).toBe("error");
    expect(getOnlineMachines().some((m) => m.machineId === "m_anon")).toBe(false);
  });

  it("rejects registration with wrong secret / malformed token without crashing", () => {
    const deps = makeDeps();
    const ws = new MockWs();
    const state = createConnState();
    const ts = Date.now();
    handleRelayInbound(asWs(ws), JSON.stringify({
      type: "daemon-register", machineId: "m_x", machineName: "Evil",
      authToken: "abcd", timestamp: ts,
    }), state, deps);
    expect(state.role).toBe("unknown");
    expect(ws.sent.at(-1).type).toBe("error");
  });
});

describe("response identity binding (防跨 daemon 伪造)", () => {
  it("forwards forward-response only from the owning daemon", () => {
    const deps = makeDeps();
    const a = registerDaemonVia(deps, "m_A");
    const b = registerDaemonVia(deps, "m_B");
    cleanups.push(a.ws, b.ws);

    const app = new MockWs();
    deps.requests.track("r1", asWs(app), "m_A");

    // 恶意 daemon B 用 A 的 requestId 伪造响应 → 丢弃
    handleRelayInbound(asWs(b.ws), JSON.stringify({
      type: "forward-response", requestId: "r1", payload: { type: "done" },
    }), b.state, deps);
    expect(app.sent.length).toBe(0);
    expect(deps.requests.get("r1")).toBeDefined(); // 请求未被恶意消费

    // 正主 A 的响应照常转发并清理
    handleRelayInbound(asWs(a.ws), JSON.stringify({
      type: "forward-response", requestId: "r1", payload: { type: "done" },
    }), a.state, deps);
    expect(app.sent.at(-1)).toEqual({ type: "relay-response", requestId: "r1", payload: { type: "done" } });
    expect(deps.requests.get("r1")).toBeUndefined();
  });

  it("forward-stream from non-owner is dropped; owner's 'done' clears tracking", () => {
    const deps = makeDeps();
    const a = registerDaemonVia(deps, "m_A2");
    const b = registerDaemonVia(deps, "m_B2");
    cleanups.push(a.ws, b.ws);
    const app = new MockWs();
    deps.requests.track("r2", asWs(app), "m_A2");

    handleRelayInbound(asWs(b.ws), JSON.stringify({
      type: "forward-stream", requestId: "r2", payload: { type: "text-delta", text: "evil" },
    }), b.state, deps);
    expect(app.sent.length).toBe(0);

    handleRelayInbound(asWs(a.ws), JSON.stringify({
      type: "forward-stream", requestId: "r2", payload: { type: "done" },
    }), a.state, deps);
    expect(app.sent.at(-1).type).toBe("relay-stream");
    expect(deps.requests.get("r2")).toBeUndefined();
  });

  it("drops heartbeat for a machineId the connection did not register (防伪造心跳)", () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps();
      const a = registerDaemonVia(deps, "m_A3");
      const b = registerDaemonVia(deps, "m_B3");
      cleanups.push(a.ws, b.ws);
      const before = getOnlineMachines().find((m) => m.machineId === "m_A3")!.lastSeen;

      vi.advanceTimersByTime(30_000);
      handleRelayInbound(asWs(b.ws), JSON.stringify({
        type: "daemon-heartbeat", machineId: "m_A3", timestamp: Date.now(),
      }), b.state, deps);
      expect(getOnlineMachines().find((m) => m.machineId === "m_A3")!.lastSeen).toBe(before);

      // 正主心跳生效
      handleRelayInbound(asWs(a.ws), JSON.stringify({
        type: "daemon-heartbeat", machineId: "m_A3", timestamp: Date.now(),
      }), a.state, deps);
      expect(getOnlineMachines().find((m) => m.machineId === "m_A3")!.lastSeen).toBeGreaterThan(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes sender identity to TunnelHub so forged tunnel frames are dropped", () => {
    const deps = makeDeps();
    const a = registerDaemonVia(deps, "m_A4");
    const b = registerDaemonVia(deps, "m_B4");
    cleanups.push(a.ws, b.ws);
    const res = { writeHead: vi.fn(), write: vi.fn(), end: vi.fn() } as any;
    deps.tunnelHub.open("t1", res, "m_A4");

    handleRelayInbound(asWs(b.ws), JSON.stringify({
      type: "tunnel-end", tunnelId: "t1",
    }), b.state, deps);
    expect(res.end).not.toHaveBeenCalled();

    handleRelayInbound(asWs(a.ws), JSON.stringify({
      type: "tunnel-end", tunnelId: "t1",
    }), a.state, deps);
    expect(res.end).toHaveBeenCalled();
  });
});

describe("boundary validation (safeParse)", () => {
  it("replies error to invalid JSON and unknown types without crashing", () => {
    const deps = makeDeps();
    const ws = new MockWs();
    const state = createConnState();
    handleRelayInbound(asWs(ws), "not json{", state, deps);
    expect(ws.sent.at(-1)).toEqual({ type: "error", error: "Invalid JSON" });
    handleRelayInbound(asWs(ws), JSON.stringify({ type: "hack-the-planet" }), state, deps);
    expect(ws.sent.at(-1).type).toBe("error");
  });

  it("replies pair-response(success:false) to malformed pair-request", () => {
    const deps = makeDeps();
    const ws = new MockWs();
    const state = createConnState();
    handleRelayInbound(asWs(ws), JSON.stringify({
      type: "pair-request", pairingCode: "short", deviceId: "d", deviceName: "P",
    }), state, deps);
    expect(ws.sent.at(-1).type).toBe("pair-response");
    expect(ws.sent.at(-1).success).toBe(false);
  });

  // relay 拆分(protocol-core): RelayRequest.payload 放宽为 z.record(z.unknown()),
  // 中继不再校验业务 payload 形状(业务校验下沉到 daemon 的 WsMessage.safeParse 兜底)。
  // 故此处不透 WsMessage 的 payload 在边界层已合法通过,仅在路由到达 daemon-not-online
  // 分支时按常规离线错误处理(而非旧版的 boundary "error")。
  it("routes relay-request with a non-WsMessage payload (boundary no longer validates payload shape)", () => {
    const deps = makeDeps();
    const ws = new MockWs();
    const state = createConnState();
    handleRelayInbound(asWs(ws), JSON.stringify({
      type: "relay-request", token: "j", machineId: "m_A", requestId: "r9",
      payload: { type: "not-a-real-type" },
    }), state, deps);
    expect(ws.sent.at(-1).type).toBe("relay-response");
    expect(deps.requests.get("r9")).toBeUndefined();
  });

  it("routes a valid relay-request and replies offline error when daemon is absent", () => {
    const deps = makeDeps();
    const ws = new MockWs();
    const state = createConnState();
    handleRelayInbound(asWs(ws), JSON.stringify({
      type: "relay-request", token: "jwt", machineId: "m_ghost", requestId: "r10",
      payload: { type: "abort" },
    }), state, deps);
    expect(state.role).toBe("app");
    expect(ws.sent.at(-1).type).toBe("relay-response");
    expect(ws.sent.at(-1).payload.type).toBe("error");
    expect(deps.requests.get("r10")).toBeUndefined(); // 离线时清理跟踪
  });
});

describe("daemon role lock (防止 daemon 连接被 app 消息降级角色, I-1)", () => {
  it("rejects relay-request from an already-registered daemon and keeps role as daemon", () => {
    const deps = makeDeps();
    const { ws, state } = registerDaemonVia(deps, "m_lock1");
    cleanups.push(ws);

    handleRelayInbound(asWs(ws), JSON.stringify({
      type: "relay-request", token: "jwt", machineId: "m_lock1", requestId: "r_lock1",
      payload: { type: "abort" },
    }), state, deps);

    expect(ws.sent.at(-1)).toEqual({
      type: "error",
      error: "Daemon connection cannot send app messages",
    });
    expect(state.role).toBe("daemon");
    expect(deps.requests.get("r_lock1")).toBeUndefined();
  });

  it("rejects list-machines from an already-registered daemon and keeps role as daemon", () => {
    const deps = makeDeps();
    const { ws, state } = registerDaemonVia(deps, "m_lock2");
    cleanups.push(ws);

    handleRelayInbound(asWs(ws), JSON.stringify({ type: "list-machines" }), state, deps);

    expect(ws.sent.at(-1)).toEqual({
      type: "error",
      error: "Daemon connection cannot send app messages",
    });
    expect(state.role).toBe("daemon");
  });

  it("rejects pair-request from an already-registered daemon and keeps role as daemon", () => {
    const deps = makeDeps();
    const { ws, state } = registerDaemonVia(deps, "m_lock3");
    cleanups.push(ws);

    handleRelayInbound(asWs(ws), JSON.stringify({
      type: "pair-request", pairingCode: "ABCD2345", deviceId: "d", deviceName: "P",
    }), state, deps);

    expect(ws.sent.at(-1)).toEqual({
      type: "error",
      error: "Daemon connection cannot send app messages",
    });
    expect(state.role).toBe("daemon");
  });
});

describe("daemon re-registration guard (防止同 socket 换 machineId 留僵尸记录, I-2)", () => {
  it("rejects re-registration with a different machineId on the same connection", () => {
    const deps = makeDeps();
    const { ws, state } = registerDaemonVia(deps, "m_orig");
    cleanups.push(ws);

    const ts = Date.now();
    handleRelayInbound(asWs(ws), JSON.stringify({
      type: "daemon-register", machineId: "m_other", machineName: "Other",
      authToken: hmac("m_other", ts), timestamp: ts,
    }), state, deps);

    expect(ws.sent.at(-1)).toEqual({
      type: "error",
      error: "Connection already registered as a different machine",
    });
    expect(state.machineId).toBe("m_orig");
    expect(getOnlineMachines().some((m) => m.machineId === "m_other")).toBe(false);
  });

  it("allows idempotent re-registration with the same machineId (reconnect semantics)", () => {
    const deps = makeDeps();
    const { ws, state } = registerDaemonVia(deps, "m_same");
    cleanups.push(ws);

    const ts = Date.now();
    handleRelayInbound(asWs(ws), JSON.stringify({
      type: "daemon-register", machineId: "m_same", machineName: "M-m_same",
      authToken: hmac("m_same", ts), timestamp: ts,
    }), state, deps);

    expect(ws.sent.at(-1)).toEqual({ type: "daemon-registered", machineId: "m_same" });
    expect(state.machineId).toBe("m_same");
  });
});

describe("WS tunnel frames (P7 HMR body ownership)", () => {
  it("routes ws-tunnel frames only from the owning daemon", () => {
    const deps = makeDeps();
    const a = registerDaemonVia(deps, "m_WA");
    const b = registerDaemonVia(deps, "m_WB");
    cleanups.push(a.ws, b.ws);
    const browser = { readyState: 1, sent: [] as any[], on() {}, send(d: any) { this.sent.push(d); }, close() {} };
    deps.wsTunnelHub.open("ws_r1", browser as any, "m_WA");
    deps.wsTunnelHub.onOpened("ws_r1", "m_WA");

    handleRelayInbound(asWs(b.ws), JSON.stringify({
      type: "tunnel-ws-data", tunnelId: "ws_r1", data: "evil",
    }), b.state, deps);
    expect(browser.sent).toHaveLength(0); // 伪造者被 hub 归属校验丢弃

    handleRelayInbound(asWs(a.ws), JSON.stringify({
      type: "tunnel-ws-data", tunnelId: "ws_r1", data: "legit",
    }), a.state, deps);
    expect(browser.sent[0]).toBe("legit");
  });
});
