import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ServerConnection,
  type ConnectionConfig,
  type ConnectionHandlers,
} from "./serverConnection";
import nacl from "tweetnacl";

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CLOSED;
  sent: string[] = [];
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number; reason: string }) => void;
  onerror?: () => void;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: "" });
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
  ws.onclose?.({ code: 1006, reason: "network lost" });
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
    expect(conn.isOpen).toBe(true);
    expect(conn.isReady).toBe(false);
    expect(JSON.parse(ws.sent[0])).toEqual({ type: "register", deviceId: "d_1" });
    conn.disconnect();
  });

  it("becomes ready only after backlog completion and resets on disconnect", () => {
    const conn = new ServerConnection(makeConfig(), makeHandlers());
    conn.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    expect(conn.isReady).toBe(false);
    ws.receive({
      type: "session",
      sessionId: "s1",
      projectId: "",
      workspace: "/w",
      backlogPending: true,
    });
    expect(conn.isReady).toBe(false);
    ws.receive({ type: "session-ready", sessionId: "s1" });
    expect(conn.isReady).toBe(true);
    conn.disconnect();
    expect(conn.isReady).toBe(false);
  });

  it("notifies once on intentional disconnect before clearing turn-correlation capability", () => {
    const capabilitiesAtDisconnect: boolean[] = [];
    let conn!: ServerConnection;
    const disconnected = vi.fn(() => capabilitiesAtDisconnect.push(conn.supportsTurnCorrelation));
    conn = new ServerConnection(makeConfig(), makeHandlers({ onDisconnected: disconnected }));
    conn.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.receive({
      type: "session",
      sessionId: "s1",
      projectId: "",
      workspace: "/w",
      turnCorrelationVersion: 1,
    });

    conn.disconnect();

    expect(disconnected).toHaveBeenCalledTimes(1);
    expect(capabilitiesAtDisconnect).toEqual([true]);
    expect(conn.supportsTurnCorrelation).toBe(false);
    expect(conn.isOpen).toBe(false);
  });

  it.each([
    {
      name: "register",
      config: makeConfig(),
      failWrite: (ws: FakeWebSocket) => {
        ws.send = () => {
          throw new Error("register write failed");
        };
      },
    },
    {
      name: "direct init",
      config: makeConfig({ getAuthToken: () => "tok_1" }),
      failWrite: (ws: FakeWebSocket) => {
        ws.send = () => {
          throw new Error("init write failed");
        };
      },
    },
    {
      name: "Relay init",
      config: makeConfig({
        isRelayMode: () => true,
        isRelayPaired: () => true,
        getRelayOptions: () => ({ machineId: "m_1", deviceId: "d_1", token: "tok_1" }),
      }),
      failWrite: (ws: FakeWebSocket) => {
        ws.send = () => {
          throw new Error("relay init write failed");
        };
      },
    },
  ])("closes and reconnects when the $name handshake write fails", ({ config, failWrite }) => {
    vi.useFakeTimers();
    const conn = new ServerConnection(config, makeHandlers());
    conn.connect();
    const ws = FakeWebSocket.instances[0];
    failWrite(ws);

    ws.open();

    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
    vi.advanceTimersByTime(2_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    conn.disconnect();
  });

  it("closes and reconnects when the post-registration init write fails", () => {
    vi.useFakeTimers();
    const conn = new ServerConnection(makeConfig(), makeHandlers());
    conn.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.send = () => {
      throw new Error("auth init write failed");
    };

    ws.receive({ type: "auth", token: "tok_1", userId: "u_1" });

    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
    vi.advanceTimersByTime(2_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    conn.disconnect();
  });

  it("returns false when the underlying socket write throws", () => {
    const conn = new ServerConnection(makeConfig(), makeHandlers());
    conn.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.send = () => {
      throw new Error("write failed");
    };
    expect(conn.sendRaw({ type: "message", content: "hello" })).toBe(false);
    conn.disconnect();
  });

  it("rejects an RPC immediately when its socket write fails", async () => {
    const conn = new ServerConnection(makeConfig(), makeHandlers());
    conn.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.send = () => {
      throw new Error("write failed");
    };

    await expect(conn.listFiles(".")).rejects.toThrow("WebSocket send failed");
    conn.disconnect();
  });

  it("rejects pending RPCs immediately on intentional disconnect", async () => {
    const conn = new ServerConnection(makeConfig(), makeHandlers());
    conn.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    const pending = conn.listFiles("src");
    const rejection = expect(pending).rejects.toThrow("WebSocket disconnected");

    conn.disconnect();

    await rejection;
  });

  it("rejects pending RPCs immediately on unexpected close", async () => {
    vi.useFakeTimers();
    const conn = new ServerConnection(makeConfig(), makeHandlers());
    conn.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    const pending = conn.listFiles("src");
    const rejection = expect(pending).rejects.toThrow("WebSocket disconnected");

    closeSocket(ws);

    await rejection;
    conn.disconnect();
  });

  it("keeps new servers unready until session-ready but accepts legacy session acks", () => {
    const ready: string[] = [];
    const conn = new ServerConnection(
      makeConfig(),
      makeHandlers({ onSessionReady: (sessionId) => ready.push(sessionId) })
    );
    conn.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.receive({
      type: "session",
      sessionId: "new",
      projectId: "",
      workspace: "/w",
      backlogPending: true,
    });
    expect(conn.isReady).toBe(false);
    ws.receive({ type: "session-ready", sessionId: "new" });
    expect(conn.isReady).toBe(true);
    expect(ready).toEqual(["new"]);
    conn.disconnect();

    const legacy = new ServerConnection(makeConfig(), makeHandlers());
    legacy.connect();
    const legacyWs = FakeWebSocket.instances[1];
    legacyWs.open();
    legacyWs.receive({ type: "session", sessionId: "old", projectId: "", workspace: "/w" });
    expect(legacy.isReady).toBe(true);
    legacy.disconnect();
  });

  it("exposes strict turn correlation only after the server advertises it", () => {
    const conn = new ServerConnection(makeConfig(), makeHandlers());
    conn.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    expect(conn.supportsTurnCorrelation).toBe(false);
    ws.receive({
      type: "session",
      sessionId: "s1",
      projectId: "",
      workspace: "/w",
      turnCorrelationVersion: 1,
    });
    expect(conn.supportsTurnCorrelation).toBe(true);
    conn.disconnect();
    expect(conn.supportsTurnCorrelation).toBe(false);
  });

  it("closes and clears readiness when Relay reports the daemon offline", () => {
    vi.useFakeTimers();
    const events: any[] = [];
    const conn = new ServerConnection(
      makeConfig(),
      makeHandlers({ onAgentEvent: (event) => events.push(event) })
    );
    conn.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.receive({
      type: "session",
      sessionId: "s1",
      projectId: "",
      workspace: "/w",
      backlogPending: true,
    });
    ws.receive({ type: "session-ready", sessionId: "s1" });
    expect(conn.isReady).toBe(true);
    ws.receive({
      type: "error",
      error: "Daemon m_1 is not online.",
      turnId: "turn-1",
    });
    expect(conn.isReady).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "control-error",
      turnId: "turn-1",
    });
    vi.advanceTimersByTime(2_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    conn.disconnect();
  });

  it.each([
    {
      name: "workspace scope",
      ack: {
        type: "session",
        sessionId: "session-1",
        projectId: "10ed836e-ae48-4d67-9e26-a74cbf55a52e",
        workspace: "/w",
        workspaceScope: {
          projectId: "10ed836e-ae48-4d67-9e26-a74cbf55a52e",
          replicaId: "0f3d985e-0a3a-458e-932d-c89dbbf671c6",
          sessionId: "wrong-session",
          workspaceGeneration: 1,
          authorityId: "ce393574-d077-4ddf-a34a-bd9746277f97",
          replicaKind: "cloud",
        },
      },
      message: "invalid workspace scope",
    },
    {
      name: "workspace catalog",
      ack: {
        type: "session",
        sessionId: "session-1",
        projectId: "",
        workspace: "/w",
        workspaceCatalog: {},
      },
      message: "invalid workspace catalog",
    },
  ])(
    "stops reconnecting after an invalid $name ack but remains manually connectable",
    ({ ack, message }) => {
      vi.useFakeTimers();
      const events: any[] = [];
      const disconnected = vi.fn();
      const conn = new ServerConnection(
        makeConfig(),
        makeHandlers({ onAgentEvent: (event) => events.push(event), onDisconnected: disconnected })
      );
      conn.connect();
      const ws = FakeWebSocket.instances[0];
      ws.open();

      ws.receive(ack);

      expect(conn.isOpen).toBe(false);
      expect(conn.isReady).toBe(false);
      expect(disconnected).toHaveBeenCalledTimes(1);
      expect(events.at(-1)).toMatchObject({
        type: "error",
        message: expect.stringContaining(message),
      });
      vi.advanceTimersByTime(60_000);
      expect(FakeWebSocket.instances).toHaveLength(1);

      conn.connect();
      expect(FakeWebSocket.instances).toHaveLength(2);
      conn.disconnect();
    }
  );

  it("stops reconnecting on a fatal control error before session-ready", () => {
    vi.useFakeTimers();
    const events: any[] = [];
    const conn = new ServerConnection(
      makeConfig(),
      makeHandlers({ onAgentEvent: (event) => events.push(event) })
    );
    conn.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();

    ws.receive({ type: "error", error: "Session does not belong to this user" });

    expect(conn.isOpen).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "control-error",
      message: "Session does not belong to this user",
    });
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);

    conn.connect();
    expect(FakeWebSocket.instances).toHaveLength(2);
    conn.disconnect();
  });

  it("keeps a ready connection open for a non-fatal control error", () => {
    const events: any[] = [];
    const conn = new ServerConnection(
      makeConfig(),
      makeHandlers({ onAgentEvent: (event) => events.push(event) })
    );
    conn.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.receive({ type: "session", sessionId: "s1", projectId: "", workspace: "/w" });

    ws.receive({ type: "error", error: "Operation rejected" });

    expect(conn.isOpen).toBe(true);
    expect(conn.isReady).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "error", message: "Operation rejected" });
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

  it("never emits deprecated plaintext gitCredentials in current init messages", () => {
    const conn = new ServerConnection(
      makeConfig({
        getAuthToken: () => "tok_1",
        buildInitPayload: () => ({
          sessionId: "s1",
          gitCredentialProfileId: "github-pat",
          gitCredentials: [
            { platform: "github", host: "github.com", username: "u", token: "DO_NOT_SEND" },
          ],
        }),
      }),
      makeHandlers()
    );
    conn.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    const init = JSON.parse(ws.sent[0]);
    expect(init).toMatchObject({
      type: "init",
      token: "tok_1",
      sessionId: "s1",
      gitCredentialProfileId: "github-pat",
    });
    expect(init.gitCredentials).toBeUndefined();
    expect(ws.sent[0]).not.toContain("DO_NOT_SEND");
    conn.disconnect();
  });

  // ── P14:事件游标(去重/缺口/resync)────────────────────
  describe("P14 event cursor", () => {
    /** 建立连接并采纳冷启动游标(session ack epoch/currentSeq)。 */
    function openWithEpoch(handlers = makeHandlers(), config = makeConfig(), currentSeq = 0) {
      const conn = new ServerConnection(config, handlers);
      conn.connect();
      const ws = FakeWebSocket.instances.at(-1)!;
      ws.open();
      ws.receive({
        type: "session",
        sessionId: "s1",
        projectId: "",
        workspace: "/w",
        eventEpoch: "ep_1",
        currentSeq,
      });
      return { conn, ws };
    }

    it("① dedup: duplicate seq applied at most once (C14-3)", () => {
      const received: any[] = [];
      const { conn, ws } = openWithEpoch(makeHandlers({ onAgentEvent: (ev) => received.push(ev) }));
      ws.receive({ type: "text-delta", text: "a", seq: 1 });
      ws.receive({ type: "text-delta", text: "b", seq: 2 });
      ws.receive({ type: "text-delta", text: "b-dup", seq: 2 });
      ws.receive({ type: "text-delta", text: "c", seq: 3 });
      expect(received.map((e) => e.seq)).toEqual([1, 2, 3]);
      conn.disconnect();
    });

    it("② seq-less events pass through without moving the cursor (兼容 geek/旧端)", () => {
      const received: any[] = [];
      const { conn, ws } = openWithEpoch(makeHandlers({ onAgentEvent: (ev) => received.push(ev) }));
      ws.receive({ type: "text-delta", text: "a", seq: 1 });
      ws.receive({ type: "usage", inputTokens: 1, outputTokens: 1 }); // 无 seq
      ws.receive({ type: "text-delta", text: "b", seq: 2 });
      expect(received.length).toBe(3);
      conn.disconnect();
    });

    it("③ first gap → drop event, close socket, reconnect init carries lastSeq/eventEpoch", () => {
      vi.useFakeTimers();
      const received: any[] = [];
      const config = makeConfig({
        getAuthToken: () => "tok",
        buildInitPayload: () => ({ sessionId: "s1" }),
      });
      const { conn, ws } = openWithEpoch(
        makeHandlers({ onAgentEvent: (ev) => received.push(ev) }),
        config
      );
      ws.receive({ type: "text-delta", text: "a", seq: 1 });
      ws.receive({ type: "text-delta", text: "jump", seq: 5 }); // 缺口
      expect(received.map((e: any) => e.seq)).toEqual([1]); // 跳号事件未投递
      expect(ws.readyState).toBe(FakeWebSocket.CLOSED); // 主动断开
      vi.advanceTimersByTime(2_000); // 第 1 次退避重连
      const ws2 = FakeWebSocket.instances.at(-1)!;
      expect(ws2).not.toBe(ws);
      ws2.open();
      const init = ws2.sent.map((s) => JSON.parse(s)).find((m) => m.type === "init");
      expect(init.lastSeq).toBe(1);
      expect(init.eventEpoch).toBe("ep_1");
      conn.disconnect();
    });

    it("④ second consecutive gap → onResyncRequired('gap') and cursor jumps to current", () => {
      vi.useFakeTimers();
      const resyncs: string[] = [];
      const received: any[] = [];
      const config = makeConfig({ getAuthToken: () => "tok" });
      const handlers = makeHandlers({
        onAgentEvent: (ev: any) => received.push(ev),
        onResyncRequired: (reason: string) => resyncs.push(reason),
      } as any);
      const { conn, ws } = openWithEpoch(handlers, config);
      ws.receive({ type: "text-delta", text: "a", seq: 1 });
      ws.receive({ type: "text-delta", text: "gap1", seq: 5 }); // 第一次缺口 → 断开
      vi.advanceTimersByTime(2_000);
      const ws2 = FakeWebSocket.instances.at(-1)!;
      ws2.open();
      ws2.receive({
        type: "session",
        sessionId: "s1",
        projectId: "",
        workspace: "/w",
        eventEpoch: "ep_1",
        currentSeq: 1,
      });
      ws2.receive({ type: "text-delta", text: "gap2", seq: 9 }); // 第二次缺口 → resync
      expect(resyncs).toEqual(["gap"]);
      expect((received.at(-1) as any).seq).toBe(9); // 采纳现值后放行
      ws2.receive({ type: "text-delta", text: "next", seq: 10 }); // 从此正常续
      expect((received.at(-1) as any).seq).toBe(10);
      conn.disconnect();
    });

    it("⑤ resync-required message → onResyncRequired(reason) + cursor adopts server values", () => {
      const resyncs: string[] = [];
      const received: any[] = [];
      const handlers = makeHandlers({
        onAgentEvent: (ev: any) => received.push(ev),
        onResyncRequired: (reason: string) => resyncs.push(reason),
      } as any);
      const { conn, ws } = openWithEpoch(handlers);
      ws.receive({
        type: "resync-required",
        reason: "epoch-changed",
        eventEpoch: "ep_2",
        currentSeq: 40,
      });
      expect(resyncs).toEqual(["epoch-changed"]);
      ws.receive({ type: "text-delta", text: "old", seq: 40 }); // ≤ 游标 → 丢弃
      ws.receive({ type: "text-delta", text: "new", seq: 41 });
      expect(received.map((e: any) => e.seq)).toEqual([41]);
      conn.disconnect();
    });

    it("⑥ cold start adopts ack epoch/currentSeq; next seq flows", () => {
      const received: any[] = [];
      const { conn, ws } = openWithEpoch(
        makeHandlers({ onAgentEvent: (ev) => received.push(ev) }),
        makeConfig(),
        7
      );
      ws.receive({ type: "text-delta", text: "a", seq: 8 });
      ws.receive({ type: "text-delta", text: "stale", seq: 7 }); // ≤ currentSeq → 丢弃
      expect(received.map((e: any) => e.seq)).toEqual([8]);
      conn.disconnect();
    });

    it("⑥a delivers the entire announced backlog before advancing to session-ready", () => {
      const received: any[] = [];
      const ready: string[] = [];
      const conn = new ServerConnection(
        makeConfig(),
        makeHandlers({
          onAgentEvent: (event) => received.push(event),
          onSessionReady: (sessionId) => ready.push(sessionId),
        })
      );
      conn.connect();
      const ws = FakeWebSocket.instances.at(-1)!;
      ws.open();
      ws.receive({
        type: "session",
        sessionId: "s1",
        projectId: "",
        workspace: "/w",
        eventEpoch: "ep_1",
        currentSeq: 3,
        backlogPending: true,
      });
      ws.receive({ type: "text-delta", text: "a", seq: 1 });
      ws.receive({ type: "text-delta", text: "b", seq: 2 });
      ws.receive({ type: "done", stopReason: "end_turn", seq: 3 });
      expect(received.map((event) => event.seq)).toEqual([1, 2, 3]);
      expect(conn.isReady).toBe(false);

      ws.receive({
        type: "session-ready",
        sessionId: "s1",
        eventEpoch: "ep_1",
        currentSeq: 3,
      });
      expect(conn.isReady).toBe(true);
      expect(ready).toEqual(["s1"]);
      ws.receive({ type: "text-delta", text: "duplicate", seq: 2 });
      expect(received.map((event) => event.seq)).toEqual([1, 2, 3]);
      conn.disconnect();
    });

    it("⑥b explicit session switch resets the old epoch and accepts the new stream", () => {
      const received: any[] = [];
      const config = makeConfig({
        getAuthToken: () => "tok",
        buildInitPayload: () => ({ sessionId: "next-session" }),
      });
      const { conn, ws } = openWithEpoch(
        makeHandlers({ onAgentEvent: (event) => received.push(event) }),
        config,
        7
      );
      ws.receive({ type: "text-delta", text: "old", seq: 8 });
      conn.disconnect();
      conn.resetSessionCursor();

      conn.connect();
      const nextSocket = FakeWebSocket.instances.at(-1)!;
      nextSocket.open();
      const init = nextSocket.sent.map((value) => JSON.parse(value)).find((m) => m.type === "init");
      expect(init).toMatchObject({ type: "init", sessionId: "next-session" });
      expect(init).not.toHaveProperty("eventEpoch");
      expect(init).not.toHaveProperty("lastSeq");

      nextSocket.receive({
        type: "session",
        sessionId: "next-session",
        projectId: "",
        workspace: "/w",
        eventEpoch: "ep_2",
        currentSeq: 0,
      });
      nextSocket.receive({ type: "text-delta", text: "new", seq: 1 });
      expect(received.map((event) => event.seq)).toEqual([8, 1]);
      conn.disconnect();
    });

    it("⑦ error 分流(D-P14-6): message 形态原样进 onAgentEvent;error 形态走控制路径", () => {
      const received: any[] = [];
      const authErrors: string[] = [];
      const handlers = makeHandlers({
        onAgentEvent: (ev: any) => received.push(ev),
        onAuthError: (m) => authErrors.push(m),
      });
      const { conn, ws } = openWithEpoch(handlers);
      ws.receive({ type: "error", message: "model down", seq: 1 });
      expect(received.at(-1)).toMatchObject({ type: "error", message: "model down" }); // 不再是 "unknown"
      ws.receive({ type: "error", error: "Unauthorized: bad token" });
      expect(authErrors.length).toBe(1); // 停连逻辑回归
      conn.disconnect();
    });
  });

  it("step-retrying / media-degraded / done(stopReason) 均路由到 onAgentEvent(派生集合覆盖新事件)", () => {
    const received: unknown[] = [];
    const conn = new ServerConnection(
      makeConfig(),
      makeHandlers({ onAgentEvent: (ev) => received.push(ev) })
    );
    conn.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    const retry = {
      type: "step-retrying",
      failedAttempt: 1,
      nextAttempt: 2,
      maxAttempts: 5,
      delayMs: 500,
    };
    const deg = { type: "media-degraded", level: "stripped", keptImages: 0 };
    const done = { type: "done", stopReason: "max_steps" };
    ws.receive(retry);
    ws.receive(deg);
    ws.receive(done);
    expect(received).toEqual([retry, deg, done]);
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

  it("correlates linked workspace import responses by request id", async () => {
    const conn = new ServerConnection(makeConfig(), makeHandlers());
    conn.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();

    const pending = conn.bindLinkedWorkspace({
      projectId: "10ed836e-ae48-4d67-9e26-a74cbf55a52e",
      displayName: "Existing project",
      path: "/Users/example/code/project",
    });
    const sent = JSON.parse(ws.sent.at(-1)!);
    expect(sent).toMatchObject({
      type: "workspace-bind-linked",
      path: "/Users/example/code/project",
    });
    ws.receive({
      type: "workspace-import-result",
      _reqId: sent._reqId,
      status: "blocked",
      existingProjectId: "0f3d985e-0a3a-458e-932d-c89dbbf671c6",
    });
    await expect(pending).resolves.toMatchObject({
      status: "blocked",
      existingProjectId: "0f3d985e-0a3a-458e-932d-c89dbbf671c6",
    });
    conn.disconnect();
  });

  it("correlates linked source status responses by request id", async () => {
    const conn = new ServerConnection(makeConfig(), makeHandlers());
    conn.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    const projectId = "10ed836e-ae48-4d67-9e26-a74cbf55a52e";

    const pending = conn.inspectWorkspaceSource(projectId);
    const sent = JSON.parse(ws.sent.at(-1)!);
    expect(sent).toMatchObject({ type: "workspace-source-inspect", projectId });
    ws.receive({
      type: "workspace-source-status",
      _reqId: sent._reqId,
      projectId,
      state: "permission-lost",
      checkedAt: 123,
      canonicalLocator: "/Users/example/code/project",
    });
    await expect(pending).resolves.toMatchObject({
      projectId,
      state: "permission-lost",
    });
    conn.disconnect();
  });

  it("correlates generation-guarded writer release responses", async () => {
    const conn = new ServerConnection(makeConfig(), makeHandlers());
    conn.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    const projectId = "10ed836e-ae48-4d67-9e26-a74cbf55a52e";
    const replicaId = "0f3d985e-0a3a-458e-932d-c89dbbf671c6";
    const pending = conn.releaseWorkspaceWriter({
      projectId,
      replicaId,
      workspaceGeneration: 2,
    });
    const sent = JSON.parse(ws.sent.at(-1)!);
    expect(sent).toMatchObject({
      type: "workspace-writer-release",
      projectId,
      replicaId,
      workspaceGeneration: 2,
    });
    ws.receive({
      type: "workspace-writer-released",
      projectId,
      replicaId,
      success: true,
      workspaceGeneration: 3,
      _reqId: sent._reqId,
    });
    await expect(pending).resolves.toMatchObject({ success: true, workspaceGeneration: 3 });
    conn.disconnect();
  });

  it("correlates explicit legacy cleanup responses", async () => {
    const conn = new ServerConnection(makeConfig(), makeHandlers());
    conn.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    const projectId = "10ed836e-ae48-4d67-9e26-a74cbf55a52e";
    const pending = conn.cleanupLegacyWorkspace(projectId, "old-project");
    const sent = JSON.parse(ws.sent.at(-1)!);
    expect(sent).toMatchObject({
      type: "workspace-legacy-cleanup",
      projectId,
      legacyProjectId: "old-project",
    });
    ws.receive({
      type: "workspace-legacy-cleaned",
      _reqId: sent._reqId,
      projectId,
      legacyProjectId: "old-project",
      success: true,
      cleaned: true,
    });
    await expect(pending).resolves.toMatchObject({ success: true, cleaned: true });
    conn.disconnect();
  });

  it("correlates credential and Git workspace RPC responses", async () => {
    const conn = new ServerConnection(makeConfig(), makeHandlers());
    conn.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    const profile = {
      id: "github-main",
      provider: "github" as const,
      authKind: "pat" as const,
      origin: "https://github.com",
      username: "octocat",
    };

    const upsert = conn.upsertGitCredential({ profile, secret: "github_pat_test" });
    const upsertRequest = JSON.parse(ws.sent.at(-1)!);
    expect(upsertRequest).toMatchObject({
      type: "git-credential-upsert",
      profile,
      secret: "github_pat_test",
    });
    ws.receive({
      type: "git-credential-result",
      _reqId: upsertRequest._reqId,
      credentialProfileId: profile.id,
      operation: "upsert",
      success: true,
    });
    await expect(upsert).resolves.toMatchObject({ success: true, operation: "upsert" });

    const projectId = "10ed836e-ae48-4d67-9e26-a74cbf55a52e";
    const operation = conn.runGitWorkspaceOperation({
      projectId,
      operation: "pull",
      credentialProfileId: profile.id,
    });
    const operationRequest = JSON.parse(ws.sent.at(-1)!);
    expect(operationRequest).toMatchObject({ type: "git-workspace-operation", operation: "pull" });
    ws.receive({
      type: "git-operation-result",
      _reqId: operationRequest._reqId,
      projectId,
      operation: "pull",
      success: true,
      head: "abc123",
    });
    await expect(operation).resolves.toMatchObject({ success: true, head: "abc123" });
    conn.disconnect();
  });

  it("automatically seals Relay credential upserts to the pinned daemon key", async () => {
    const daemonSecret = Uint8Array.from({ length: 32 }, (_, index) => 150 - index);
    const daemonKey = nacl.box.keyPair.fromSecretKey(daemonSecret);
    const conn = new ServerConnection(
      makeConfig({
        isRelayMode: () => true,
        isRelayPaired: () => true,
        getRelayOptions: () => ({
          machineId: "m_1",
          deviceId: "d_1",
          token: "device-token",
          publicKey: Buffer.from(daemonKey.publicKey).toString("base64"),
          keyId: "daemon-key-1",
        }),
      }),
      makeHandlers()
    );
    conn.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    const profile = {
      id: "gitlab-company",
      provider: "gitlab" as const,
      authKind: "pat" as const,
      origin: "https://gitlab.company.test",
    };
    const pending = conn.upsertGitCredential({
      profile,
      secret: "glpat_DO_NOT_EXPOSE",
      randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index + 1),
    });
    const envelope = JSON.parse(ws.sent.at(-1)!);
    expect(envelope.type).toBe("relay-request");
    expect(envelope.payload).toMatchObject({ type: "git-credential-upsert", profile });
    expect(envelope.payload.secret).toBeUndefined();
    expect(envelope.payload.sealedSecret).toMatchObject({
      keyId: "daemon-key-1",
      profileId: profile.id,
      origin: profile.origin,
      requestId: envelope.payload._reqId,
    });
    expect(ws.sent.at(-1)).not.toContain("glpat_DO_NOT_EXPOSE");

    ws.receive({
      type: "relay-response",
      requestId: envelope.requestId,
      payload: {
        type: "git-credential-result",
        _reqId: envelope.payload._reqId,
        credentialProfileId: profile.id,
        operation: "upsert",
        success: true,
      },
    });
    await expect(pending).resolves.toMatchObject({ success: true });
    conn.disconnect();
  });

  it("keeps remote Git imports alive beyond the server's ten-minute command timeout", async () => {
    vi.useFakeTimers();
    const conn = new ServerConnection(makeConfig(), makeHandlers());
    conn.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    const pending = conn.importGitWorkspace({
      projectId: "10ed836e-ae48-4d67-9e26-a74cbf55a52e",
      repositoryUrl: "https://github.com/acme/large-repo.git",
      credentialProfileId: "github-main",
    });
    let settled = false;
    void pending.then(
      () => (settled = true),
      () => (settled = true)
    );
    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
    await Promise.resolve();
    expect(settled).toBe(false);
    const rejection = expect(pending).rejects.toThrow("Git workspace import timed out");
    vi.advanceTimersByTime(60 * 1000);
    await rejection;
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

  it("accepts only file events from the acknowledged workspace scope", () => {
    const files: string[] = [];
    const events: string[] = [];
    const dropped: string[] = [];
    const scope = {
      projectId: "10ed836e-ae48-4d67-9e26-a74cbf55a52e",
      replicaId: "0f3d985e-0a3a-458e-932d-c89dbbf671c6",
      sessionId: "session-1",
      workspaceGeneration: 2,
      authorityId: "ce393574-d077-4ddf-a34a-bd9746277f97",
      replicaKind: "cloud",
    };
    const conn = new ServerConnection(
      makeConfig(),
      makeHandlers({
        onAgentEvent: (event) => events.push(event.type),
        onFileChanged: (path) => files.push(path),
        onWorkspaceEventDropped: (reason) => dropped.push(reason),
      })
    );
    conn.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.receive({
      type: "session",
      sessionId: "session-1",
      projectId: scope.projectId,
      workspace: "/w",
      workspaceProtocolVersion: 2,
      workspaceScope: scope,
      eventEpoch: "ep_scope",
      currentSeq: 0,
    });
    ws.receive({
      type: "file-changed",
      path: "stale.ts",
      changeType: "modified",
      seq: 1,
      workspaceScope: { ...scope, workspaceGeneration: 1 },
    });
    ws.receive({
      type: "file-changed",
      path: "current.ts",
      changeType: "modified",
      seq: 1,
      workspaceScope: scope,
    });
    expect(files).toEqual(["current.ts"]);
    expect(events).toEqual(["file-changed"]);
    expect(dropped).toEqual(["invalid-or-stale-scope"]);
    conn.disconnect();
  });

  it("keeps unscoped v1 session and file events compatible", () => {
    const sessions: Array<[string, unknown]> = [];
    const files: string[] = [];
    const conn = new ServerConnection(
      makeConfig(),
      makeHandlers({
        onSession: (sessionId, scope) => sessions.push([sessionId, scope]),
        onFileChanged: (path) => files.push(path),
      })
    );
    conn.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.receive({ type: "session", sessionId: "legacy", projectId: "", workspace: "/w" });
    ws.receive({ type: "file-changed", path: "legacy.ts", changeType: "created" });
    expect(sessions).toEqual([["legacy", undefined]]);
    expect(files).toEqual(["legacy.ts"]);
    conn.disconnect();
  });

  it("ignores buffered events from a socket after an explicit project disconnect", () => {
    const files: string[] = [];
    const conn = new ServerConnection(
      makeConfig(),
      makeHandlers({ onFileChanged: (path) => files.push(path) })
    );
    conn.connect();
    const oldSocket = FakeWebSocket.instances[0];
    oldSocket.open();
    conn.disconnect();
    oldSocket.receive({ type: "file-changed", path: "old.ts", changeType: "modified" });
    expect(files).toEqual([]);
  });

  it("validates and forwards the remote project catalog", () => {
    const catalogs: unknown[] = [];
    const conn = new ServerConnection(
      makeConfig(),
      makeHandlers({
        onSession: (_sessionId, _scope, catalog) => catalogs.push(catalog),
      })
    );
    conn.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    const entry = {
      projectId: "10ed836e-ae48-4d67-9e26-a74cbf55a52e",
      displayName: "Remote project",
      replicaId: "0f3d985e-0a3a-458e-932d-c89dbbf671c6",
      workspaceGeneration: 2,
      authorityId: "ce393574-d077-4ddf-a34a-bd9746277f97",
      replicaKind: "cloud",
      updatedAt: 100,
    };
    ws.receive({
      type: "session",
      sessionId: "legacy",
      projectId: "",
      workspace: "/w",
      workspaceProtocolVersion: 2,
      workspaceCatalog: [entry],
    });
    expect(catalogs).toEqual([[entry]]);
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
