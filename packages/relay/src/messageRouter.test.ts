import { describe, it, expect, vi, afterEach } from "vitest";
import crypto from "crypto";
import type { WebSocket } from "ws";
import { createConnState, handleRelayInbound, type RouterDeps } from "./messageRouter.js";
import { RequestTracker } from "./requestTracker.js";
import { TunnelHub } from "./tunnelHub.js";
import { WsTunnelHub } from "./wsTunnelHub.js";
import { unregisterDaemon, getOnlineMachines } from "./relay.js";
import { handleRelayConnectionClosed } from "./connectionLifecycle.js";

const SECRET = "test-secret";

class MockWs {
  readyState = 1; // OPEN
  sent: any[] = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
}
const asWs = (m: MockWs) => m as unknown as WebSocket;

function makeDeps(): RouterDeps {
  return {
    relaySecret: SECRET,
    requests: new RequestTracker(),
    tunnelHub: new TunnelHub(),
    wsTunnelHub: new WsTunnelHub(() => true),
  };
}

function hmac(machineId: string, ts: number, secret = SECRET) {
  return crypto
    .createHmac("sha256", secret)
    .update(machineId + ts)
    .digest("hex");
}

/** 注册一个 daemon,返回其 socket 与连接状态 */
function registerDaemonVia(
  deps: RouterDeps,
  machineId: string,
  encryption?: { publicKey: string; keyId: string }
) {
  const ws = new MockWs();
  const state = createConnState();
  const ts = Date.now();
  handleRelayInbound(
    asWs(ws),
    JSON.stringify({
      type: "daemon-register",
      machineId,
      machineName: "M-" + machineId,
      authToken: hmac(machineId, ts),
      timestamp: ts,
      ...encryption,
    }),
    state,
    deps
  );
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

  it("publishes daemon credential-encryption metadata in machine discovery", () => {
    const deps = makeDeps();
    const { ws } = registerDaemonVia(deps, "m_crypto", {
      publicKey: "daemon-public-key",
      keyId: "daemon-key-1",
    });
    cleanups.push(ws);
    expect(getOnlineMachines().find((machine) => machine.machineId === "m_crypto")).toMatchObject({
      publicKey: "daemon-public-key",
      keyId: "daemon-key-1",
    });
    const app = new MockWs();
    handleRelayInbound(
      asWs(app),
      JSON.stringify({ type: "list-machines" }),
      createConnState(),
      deps
    );
    expect(app.sent.at(-1).machines).toContainEqual(
      expect.objectContaining({
        machineId: "m_crypto",
        publicKey: "daemon-public-key",
        keyId: "daemon-key-1",
      })
    );
  });

  it("rejects registration without authToken", () => {
    const deps = makeDeps();
    const ws = new MockWs();
    const state = createConnState();
    handleRelayInbound(
      asWs(ws),
      JSON.stringify({
        type: "daemon-register",
        machineId: "m_anon",
        machineName: "Evil",
      }),
      state,
      deps
    );
    expect(state.role).toBe("unknown");
    expect(ws.sent.at(-1).type).toBe("error");
    expect(getOnlineMachines().some((m) => m.machineId === "m_anon")).toBe(false);
  });

  it("rejects registration with wrong secret / malformed token without crashing", () => {
    const deps = makeDeps();
    const ws = new MockWs();
    const state = createConnState();
    const ts = Date.now();
    handleRelayInbound(
      asWs(ws),
      JSON.stringify({
        type: "daemon-register",
        machineId: "m_x",
        machineName: "Evil",
        authToken: "abcd",
        timestamp: ts,
      }),
      state,
      deps
    );
    expect(state.role).toBe("unknown");
    expect(ws.sent.at(-1).type).toBe("error");
  });

  it("ends old waiters on replacement while a late old close preserves new requests", () => {
    const deps = makeDeps();
    const oldDaemon = registerDaemonVia(deps, "m_replace");
    cleanups.push(oldDaemon.ws);
    const oldApp = new MockWs();
    handleRelayInbound(
      asWs(oldApp),
      JSON.stringify({
        type: "relay-request",
        token: "jwt",
        machineId: "m_replace",
        requestId: "old-turn",
        payload: { type: "message", content: "old" },
      }),
      createConnState(),
      deps
    );
    expect(deps.requests.get("old-turn")).toBeDefined();

    const newDaemon = registerDaemonVia(deps, "m_replace");
    cleanups.push(newDaemon.ws);
    expect(oldApp.sent.at(-1)).toEqual({
      type: "relay-response",
      requestId: "old-turn",
      payload: {
        type: "error",
        error: "Daemon m_replace is not online.",
      },
    });
    expect(deps.requests.get("old-turn")).toBeUndefined();

    const newApp = new MockWs();
    handleRelayInbound(
      asWs(newApp),
      JSON.stringify({
        type: "relay-request",
        token: "jwt",
        machineId: "m_replace",
        requestId: "new-turn",
        payload: { type: "message", content: "new" },
      }),
      createConnState(),
      deps
    );
    expect(deps.requests.get("new-turn")?.ws).toBe(asWs(newApp));

    // Real ws emits this after the replacement registration has completed.
    handleRelayConnectionClosed(asWs(oldDaemon.ws), oldDaemon.state, deps);
    expect(deps.requests.get("new-turn")?.ws).toBe(asWs(newApp));
    expect(newApp.sent).toEqual([]);

    // The replaced socket can no longer publish into a new request either.
    handleRelayInbound(
      asWs(oldDaemon.ws),
      JSON.stringify({
        type: "forward-response",
        requestId: "new-turn",
        payload: { type: "done" },
      }),
      oldDaemon.state,
      deps
    );
    expect(newApp.sent).toEqual([]);
    expect(deps.requests.get("new-turn")).toBeDefined();

    handleRelayInbound(
      asWs(newDaemon.ws),
      JSON.stringify({
        type: "forward-response",
        requestId: "new-turn",
        payload: { type: "done" },
      }),
      newDaemon.state,
      deps
    );
    expect(newApp.sent.at(-1)).toEqual({
      type: "relay-response",
      requestId: "new-turn",
      payload: { type: "done" },
    });
    expect(deps.requests.get("new-turn")).toBeUndefined();
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
    handleRelayInbound(
      asWs(b.ws),
      JSON.stringify({
        type: "forward-response",
        requestId: "r1",
        payload: { type: "done" },
      }),
      b.state,
      deps
    );
    expect(app.sent.length).toBe(0);
    expect(deps.requests.get("r1")).toBeDefined(); // 请求未被恶意消费

    // 正主 A 的响应照常转发并清理
    handleRelayInbound(
      asWs(a.ws),
      JSON.stringify({
        type: "forward-response",
        requestId: "r1",
        payload: { type: "done" },
      }),
      a.state,
      deps
    );
    expect(app.sent.at(-1)).toEqual({
      type: "relay-response",
      requestId: "r1",
      payload: { type: "done" },
    });
    expect(deps.requests.get("r1")).toBeUndefined();
  });

  it("forward-stream from non-owner is dropped; owner's 'done' clears tracking", () => {
    const deps = makeDeps();
    const a = registerDaemonVia(deps, "m_A2");
    const b = registerDaemonVia(deps, "m_B2");
    cleanups.push(a.ws, b.ws);
    const app = new MockWs();
    deps.requests.track("r2", asWs(app), "m_A2", Date.now(), "message");

    handleRelayInbound(
      asWs(b.ws),
      JSON.stringify({
        type: "forward-stream",
        requestId: "r2",
        payload: { type: "text-delta", text: "evil" },
      }),
      b.state,
      deps
    );
    expect(app.sent.length).toBe(0);

    handleRelayInbound(
      asWs(a.ws),
      JSON.stringify({
        type: "forward-stream",
        requestId: "r2",
        payload: { type: "done" },
      }),
      a.state,
      deps
    );
    expect(app.sent.at(-1).type).toBe("relay-stream");
    expect(deps.requests.get("r2")).toBeUndefined();
  });

  it("keeps init and goal streams tracked across intermediate done events", () => {
    const deps = makeDeps();
    const daemon = registerDaemonVia(deps, "m_long");
    cleanups.push(daemon.ws);
    const app = new MockWs();
    deps.requests.track("init-stream", asWs(app), "m_long", Date.now(), "init");

    handleRelayInbound(
      asWs(daemon.ws),
      JSON.stringify({
        type: "forward-stream",
        requestId: "init-stream",
        payload: { type: "done" },
      }),
      daemon.state,
      deps
    );
    expect(deps.requests.get("init-stream")).toBeDefined();

    handleRelayInbound(
      asWs(daemon.ws),
      JSON.stringify({
        type: "forward-stream",
        requestId: "init-stream",
        payload: { type: "text-delta", text: "after backlog done" },
      }),
      daemon.state,
      deps
    );
    expect(app.sent.at(-1).payload.text).toBe("after backlog done");

    handleRelayInbound(
      asWs(daemon.ws),
      JSON.stringify({
        type: "forward-response",
        requestId: "init-stream",
        payload: { type: "session-ready", sessionId: "s1" },
      }),
      daemon.state,
      deps
    );
    expect(deps.requests.get("init-stream")).toBeUndefined();
  });

  it("keeps the original type when same-id init rebinds, then clears ready-before-done", () => {
    const deps = makeDeps();
    const daemon = registerDaemonVia(deps, "m_rebind");
    cleanups.push(daemon.ws);
    const oldApp = new MockWs();
    const newApp = new MockWs();
    deps.requests.track("turn-live", asWs(oldApp), "m_rebind", Date.now(), "message");

    handleRelayInbound(
      asWs(newApp),
      JSON.stringify({
        type: "relay-request",
        token: "jwt",
        machineId: "m_rebind",
        requestId: "turn-live",
        payload: { type: "init", sessionId: "s1", activeTurnId: "turn-live" },
      }),
      createConnState(),
      deps
    );
    expect(deps.requests.get("turn-live")).toMatchObject({
      ws: asWs(newApp),
      requestType: "message",
      initPending: true,
    });

    handleRelayInbound(
      asWs(daemon.ws),
      JSON.stringify({
        type: "forward-stream",
        requestId: "turn-live",
        payload: { type: "text-delta", text: "resumed" },
      }),
      daemon.state,
      deps
    );
    expect(newApp.sent.at(-1).payload.text).toBe("resumed");
    expect(oldApp.sent).toEqual([]);

    handleRelayInbound(
      asWs(daemon.ws),
      JSON.stringify({
        type: "forward-response",
        requestId: "turn-live",
        payload: { type: "session-ready", sessionId: "s1" },
      }),
      daemon.state,
      deps
    );
    expect(deps.requests.get("turn-live")).toMatchObject({
      requestType: "message",
      initPending: false,
    });

    handleRelayInbound(
      asWs(daemon.ws),
      JSON.stringify({
        type: "forward-stream",
        requestId: "turn-live",
        payload: { type: "done" },
      }),
      daemon.state,
      deps
    );
    expect(deps.requests.get("turn-live")).toBeUndefined();
  });

  it("uses a separate init envelope tracker while rebinding activeTurnId", () => {
    const deps = makeDeps();
    const daemon = registerDaemonVia(deps, "m_separate_init");
    cleanups.push(daemon.ws);
    const oldApp = new MockWs();
    const newApp = new MockWs();
    deps.requests.track("turn-separate", asWs(oldApp), "m_separate_init", 1, "message");

    handleRelayInbound(
      asWs(newApp),
      JSON.stringify({
        type: "relay-request",
        token: "jwt",
        machineId: "m_separate_init",
        requestId: "init-envelope",
        payload: { type: "init", sessionId: "s1", activeTurnId: "turn-separate" },
      }),
      createConnState(),
      deps
    );

    expect(deps.requests.get("turn-separate")).toMatchObject({
      ws: asWs(newApp),
      requestType: "message",
    });
    expect(deps.requests.get("init-envelope")?.requestType).toBe("init");

    handleRelayInbound(
      asWs(daemon.ws),
      JSON.stringify({
        type: "forward-stream",
        requestId: "turn-separate",
        payload: { type: "done" },
      }),
      daemon.state,
      deps
    );
    expect(deps.requests.get("turn-separate")).toBeUndefined();
    expect(deps.requests.get("init-envelope")).toBeDefined();

    handleRelayInbound(
      asWs(daemon.ws),
      JSON.stringify({
        type: "forward-response",
        requestId: "init-envelope",
        payload: { type: "session-ready", sessionId: "s1" },
      }),
      daemon.state,
      deps
    );
    expect(deps.requests.get("init-envelope")).toBeUndefined();
  });

  it("retains same-id done until session-ready arrives", () => {
    const deps = makeDeps();
    const daemon = registerDaemonVia(deps, "m_done_first");
    cleanups.push(daemon.ws);
    const app = new MockWs();
    deps.requests.track("turn-done-first", asWs(app), "m_done_first", 1, "message");

    handleRelayInbound(
      asWs(app),
      JSON.stringify({
        type: "relay-request",
        token: "jwt",
        machineId: "m_done_first",
        requestId: "turn-done-first",
        payload: { type: "init", sessionId: "s1", activeTurnId: "turn-done-first" },
      }),
      createConnState(),
      deps
    );
    handleRelayInbound(
      asWs(daemon.ws),
      JSON.stringify({
        type: "forward-stream",
        requestId: "turn-done-first",
        payload: { type: "done" },
      }),
      daemon.state,
      deps
    );
    expect(deps.requests.get("turn-done-first")).toMatchObject({
      terminalSeen: true,
      initPending: true,
    });

    handleRelayInbound(
      asWs(daemon.ws),
      JSON.stringify({
        type: "forward-response",
        requestId: "turn-done-first",
        payload: { type: "session-ready", sessionId: "s1" },
      }),
      daemon.state,
      deps
    );
    expect(deps.requests.get("turn-done-first")).toBeUndefined();
  });

  it("preserves a resumed goal stream across App reconnect and intermediate done", () => {
    const deps = makeDeps();
    const daemon = registerDaemonVia(deps, "m_goal_resume");
    cleanups.push(daemon.ws);
    const oldApp = new MockWs();
    const newApp = new MockWs();
    deps.requests.track(
      "turn-goal-resume",
      asWs(oldApp),
      "m_goal_resume",
      Date.now(),
      "goal-control"
    );

    handleRelayInbound(
      asWs(newApp),
      JSON.stringify({
        type: "relay-request",
        token: "jwt",
        machineId: "m_goal_resume",
        requestId: "turn-goal-resume",
        payload: {
          type: "init",
          sessionId: "s1",
          activeTurnId: "turn-goal-resume",
        },
      }),
      createConnState(),
      deps
    );
    expect(deps.requests.get("turn-goal-resume")).toMatchObject({
      requestType: "goal-control",
      initPending: true,
    });

    handleRelayInbound(
      asWs(daemon.ws),
      JSON.stringify({
        type: "forward-stream",
        requestId: "turn-goal-resume",
        payload: { type: "done" },
      }),
      daemon.state,
      deps
    );
    expect(deps.requests.get("turn-goal-resume")).toBeDefined();

    handleRelayInbound(
      asWs(daemon.ws),
      JSON.stringify({
        type: "forward-stream",
        requestId: "turn-goal-resume",
        payload: {
          type: "goal-updated",
          status: "complete",
          change: "completion",
          stats: { turns: 1, inputTokens: 1, outputTokens: 1 },
        },
      }),
      daemon.state,
      deps
    );
    expect(newApp.sent.at(-1).payload.type).toBe("goal-updated");
    expect(deps.requests.get("turn-goal-resume")?.terminalSeen).toBe(true);

    handleRelayInbound(
      asWs(daemon.ws),
      JSON.stringify({
        type: "forward-response",
        requestId: "turn-goal-resume",
        payload: { type: "session-ready", sessionId: "s1" },
      }),
      daemon.state,
      deps
    );
    expect(deps.requests.get("turn-goal-resume")).toBeUndefined();
    expect(oldApp.sent).toEqual([]);
  });

  it("rebuilds a fresh goal tracker from activeTurnKind across ready and intermediate done", () => {
    const deps = makeDeps();
    const daemon = registerDaemonVia(deps, "m_goal_kind_reconnect");
    cleanups.push(daemon.ws);
    const app = new MockWs();
    const turnId = "turn-goal-kind";

    // Simulate a Relay process restart: there is no pre-existing tracker to
    // rebind, so init metadata is the only way to distinguish a multi-turn goal
    // from a normal message before the first goal-updated frame arrives.
    handleRelayInbound(
      asWs(app),
      JSON.stringify({
        type: "relay-request",
        token: "jwt",
        machineId: "m_goal_kind_reconnect",
        requestId: turnId,
        payload: {
          type: "init",
          sessionId: "s1",
          activeTurnId: turnId,
          activeTurnKind: "goal",
        },
      }),
      createConnState(),
      deps
    );
    expect(deps.requests.get(turnId)).toMatchObject({
      requestType: "goal-control",
      initPending: true,
    });

    handleRelayInbound(
      asWs(daemon.ws),
      JSON.stringify({
        type: "forward-stream",
        requestId: turnId,
        payload: { type: "done" },
      }),
      daemon.state,
      deps
    );
    expect(deps.requests.get(turnId)).toMatchObject({
      requestType: "goal-control",
      initPending: true,
    });

    handleRelayInbound(
      asWs(daemon.ws),
      JSON.stringify({
        type: "forward-response",
        requestId: turnId,
        payload: { type: "session-ready", sessionId: "s1" },
      }),
      daemon.state,
      deps
    );
    expect(deps.requests.get(turnId)).toMatchObject({
      requestType: "goal-control",
      initPending: false,
    });

    handleRelayInbound(
      asWs(daemon.ws),
      JSON.stringify({
        type: "forward-stream",
        requestId: turnId,
        payload: { type: "text-delta", text: "continued after reconnect" },
      }),
      daemon.state,
      deps
    );
    expect(app.sent.at(-1).payload).toEqual({
      type: "text-delta",
      text: "continued after reconnect",
    });
    expect(deps.requests.get(turnId)).toBeDefined();

    handleRelayInbound(
      asWs(daemon.ws),
      JSON.stringify({
        type: "forward-stream",
        requestId: turnId,
        payload: {
          type: "goal-updated",
          status: "complete",
          change: "completion",
          stats: { turns: 2, inputTokens: 3, outputTokens: 5 },
        },
      }),
      daemon.state,
      deps
    );
    expect(app.sent.map((frame) => frame.payload.type)).toEqual([
      "done",
      "session-ready",
      "text-delta",
      "goal-updated",
    ]);
    expect(deps.requests.get(turnId)).toBeUndefined();
  });

  it("clears a missing recovered goal only after its error, done, and same-id init ready", () => {
    const deps = makeDeps();
    const daemon = registerDaemonVia(deps, "m_goal_missing_reconnect");
    cleanups.push(daemon.ws);
    const app = new MockWs();
    const turnId = "turn-goal-missing";

    handleRelayInbound(
      asWs(app),
      JSON.stringify({
        type: "relay-request",
        token: "jwt",
        machineId: "m_goal_missing_reconnect",
        requestId: turnId,
        payload: {
          type: "init",
          sessionId: "s1",
          activeTurnId: turnId,
          activeTurnKind: "goal",
        },
      }),
      createConnState(),
      deps
    );

    handleRelayInbound(
      asWs(daemon.ws),
      JSON.stringify({
        type: "forward-stream",
        requestId: turnId,
        payload: { type: "error", code: "goal-recovery-unavailable", message: "missing" },
      }),
      daemon.state,
      deps
    );
    handleRelayInbound(
      asWs(daemon.ws),
      JSON.stringify({
        type: "forward-stream",
        requestId: turnId,
        payload: {
          type: "goal-updated",
          status: "paused",
          change: "cleared",
          stats: { turns: 0, inputTokens: 0, outputTokens: 0 },
        },
      }),
      daemon.state,
      deps
    );
    handleRelayInbound(
      asWs(daemon.ws),
      JSON.stringify({
        type: "forward-stream",
        requestId: turnId,
        payload: { type: "done", stopReason: "error" },
      }),
      daemon.state,
      deps
    );
    expect(deps.requests.get(turnId)?.terminalSeen).toBe(true);

    handleRelayInbound(
      asWs(daemon.ws),
      JSON.stringify({
        type: "forward-response",
        requestId: turnId,
        payload: { type: "session-ready", sessionId: "s1" },
      }),
      daemon.state,
      deps
    );
    expect(app.sent.map((frame) => frame.payload.type)).toEqual([
      "error",
      "goal-updated",
      "done",
      "session-ready",
    ]);
    expect(deps.requests.get(turnId)).toBeUndefined();
  });

  it("cleans goal resume only after its correlated terminal error and done", () => {
    const deps = makeDeps();
    const daemon = registerDaemonVia(deps, "m_goal_error");
    cleanups.push(daemon.ws);
    const app = new MockWs();

    handleRelayInbound(
      asWs(app),
      JSON.stringify({
        type: "relay-request",
        token: "jwt",
        machineId: "m_goal_error",
        requestId: "goal-resume-error",
        payload: {
          type: "goal-control",
          action: "resume",
          turnId: "goal-resume-error",
        },
      }),
      createConnState(),
      deps
    );

    handleRelayInbound(
      asWs(daemon.ws),
      JSON.stringify({
        type: "forward-stream",
        requestId: "goal-resume-error",
        payload: {
          type: "error",
          code: "goal-resume-unavailable",
          message: "cannot resume",
        },
      }),
      daemon.state,
      deps
    );
    expect(deps.requests.get("goal-resume-error")?.deleteAfterDone).toBe(true);

    handleRelayInbound(
      asWs(daemon.ws),
      JSON.stringify({
        type: "forward-stream",
        requestId: "goal-resume-error",
        payload: { type: "done", stopReason: "error" },
      }),
      daemon.state,
      deps
    );
    expect(deps.requests.get("goal-resume-error")).toBeUndefined();
    expect(app.sent.map((frame) => frame.payload.type)).toEqual(["error", "done"]);
  });

  it("keeps goal-create through active/intermediate done and clears when it parks", () => {
    const deps = makeDeps();
    const daemon = registerDaemonVia(deps, "m_goal_park");
    cleanups.push(daemon.ws);
    const app = new MockWs();

    handleRelayInbound(
      asWs(app),
      JSON.stringify({
        type: "relay-request",
        token: "jwt",
        machineId: "m_goal_park",
        requestId: "goal-park",
        payload: { type: "goal-create", content: "long goal" },
      }),
      createConnState(),
      deps
    );

    for (const payload of [
      {
        type: "goal-updated",
        status: "active",
        change: "lifecycle",
        stats: { turns: 0, inputTokens: 0, outputTokens: 0 },
      },
      { type: "done" },
    ]) {
      handleRelayInbound(
        asWs(daemon.ws),
        JSON.stringify({ type: "forward-stream", requestId: "goal-park", payload }),
        daemon.state,
        deps
      );
      expect(deps.requests.get("goal-park")).toBeDefined();
    }

    handleRelayInbound(
      asWs(daemon.ws),
      JSON.stringify({
        type: "forward-stream",
        requestId: "goal-park",
        payload: {
          type: "goal-updated",
          status: "paused",
          change: "lifecycle",
          stats: { turns: 1, inputTokens: 1, outputTokens: 1 },
        },
      }),
      daemon.state,
      deps
    );
    expect(deps.requests.get("goal-park")).toBeUndefined();
  });

  it("cleans one-response RPCs and explicit server errors delivered as streams", () => {
    const deps = makeDeps();
    const daemon = registerDaemonVia(deps, "m_rpc");
    cleanups.push(daemon.ws);
    const app = new MockWs();

    handleRelayInbound(
      asWs(app),
      JSON.stringify({
        type: "relay-request",
        token: "jwt",
        machineId: "m_rpc",
        requestId: "quota-rpc",
        payload: { type: "get-quota" },
      }),
      createConnState(),
      deps
    );
    handleRelayInbound(
      asWs(daemon.ws),
      JSON.stringify({
        type: "forward-stream",
        requestId: "quota-rpc",
        payload: { type: "quota" },
      }),
      daemon.state,
      deps
    );
    expect(deps.requests.get("quota-rpc")).toBeUndefined();

    handleRelayInbound(
      asWs(app),
      JSON.stringify({
        type: "relay-request",
        token: "jwt",
        machineId: "m_rpc",
        requestId: "goal-error",
        payload: { type: "goal-create", content: "ship it" },
      }),
      createConnState(),
      deps
    );
    handleRelayInbound(
      asWs(daemon.ws),
      JSON.stringify({
        type: "forward-stream",
        requestId: "goal-error",
        payload: { type: "error", error: "No session. Send init first." },
      }),
      daemon.state,
      deps
    );
    expect(deps.requests.get("goal-error")).toBeUndefined();
  });

  it("does not retain abort/pause, and clears cancel on its cleared response", () => {
    const deps = makeDeps();
    const daemon = registerDaemonVia(deps, "m_controls");
    cleanups.push(daemon.ws);
    const app = new MockWs();
    const appState = createConnState();

    for (const request of [
      { requestId: "abort-control", payload: { type: "abort" } },
      {
        requestId: "pause-control",
        payload: { type: "goal-control", action: "pause" },
      },
    ]) {
      handleRelayInbound(
        asWs(app),
        JSON.stringify({
          type: "relay-request",
          token: "jwt",
          machineId: "m_controls",
          ...request,
        }),
        appState,
        deps
      );
      expect(deps.requests.get(request.requestId)).toBeUndefined();
    }

    handleRelayInbound(
      asWs(app),
      JSON.stringify({
        type: "relay-request",
        token: "jwt",
        machineId: "m_controls",
        requestId: "old-goal-stream",
        payload: { type: "goal-create", content: "long goal" },
      }),
      appState,
      deps
    );
    handleRelayInbound(
      asWs(app),
      JSON.stringify({
        type: "relay-request",
        token: "jwt",
        machineId: "m_controls",
        requestId: "cancel-control",
        payload: { type: "goal-control", action: "cancel" },
      }),
      appState,
      deps
    );
    expect(deps.requests.get("old-goal-stream")).toBeUndefined();
    expect(deps.requests.get("cancel-control")?.requestAction).toBe("cancel");

    handleRelayInbound(
      asWs(daemon.ws),
      JSON.stringify({
        type: "forward-stream",
        requestId: "cancel-control",
        payload: {
          type: "goal-updated",
          status: "complete",
          change: "cleared",
          stats: { turns: 1, inputTokens: 1, outputTokens: 1 },
        },
      }),
      daemon.state,
      deps
    );
    expect(deps.requests.get("cancel-control")).toBeUndefined();
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
      handleRelayInbound(
        asWs(b.ws),
        JSON.stringify({
          type: "daemon-heartbeat",
          machineId: "m_A3",
          timestamp: Date.now(),
        }),
        b.state,
        deps
      );
      expect(getOnlineMachines().find((m) => m.machineId === "m_A3")!.lastSeen).toBe(before);

      // 正主心跳生效
      handleRelayInbound(
        asWs(a.ws),
        JSON.stringify({
          type: "daemon-heartbeat",
          machineId: "m_A3",
          timestamp: Date.now(),
        }),
        a.state,
        deps
      );
      expect(getOnlineMachines().find((m) => m.machineId === "m_A3")!.lastSeen).toBeGreaterThan(
        before
      );
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

    handleRelayInbound(
      asWs(b.ws),
      JSON.stringify({
        type: "tunnel-end",
        tunnelId: "t1",
      }),
      b.state,
      deps
    );
    expect(res.end).not.toHaveBeenCalled();

    handleRelayInbound(
      asWs(a.ws),
      JSON.stringify({
        type: "tunnel-end",
        tunnelId: "t1",
      }),
      a.state,
      deps
    );
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

  it("never logs a raw malformed frame that may contain a credential", () => {
    const deps = makeDeps();
    const ws = new MockWs();
    const state = createConnState();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    handleRelayInbound(
      asWs(ws),
      JSON.stringify({ type: "unknown", secret: "github_pat_DO_NOT_LOG" }),
      state,
      deps
    );
    expect(warn.mock.calls.flat().join(" ")).not.toContain("github_pat_DO_NOT_LOG");
    warn.mockRestore();
  });

  it("replies pair-response(success:false) to malformed pair-request", () => {
    const deps = makeDeps();
    const ws = new MockWs();
    const state = createConnState();
    handleRelayInbound(
      asWs(ws),
      JSON.stringify({
        type: "pair-request",
        pairingCode: "short",
        deviceId: "d",
        deviceName: "P",
      }),
      state,
      deps
    );
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
    handleRelayInbound(
      asWs(ws),
      JSON.stringify({
        type: "relay-request",
        token: "j",
        machineId: "m_A",
        requestId: "r9",
        payload: { type: "not-a-real-type" },
      }),
      state,
      deps
    );
    expect(ws.sent.at(-1).type).toBe("relay-response");
    expect(deps.requests.get("r9")).toBeUndefined();
  });

  it("routes a valid relay-request and replies offline error when daemon is absent", () => {
    const deps = makeDeps();
    const ws = new MockWs();
    const state = createConnState();
    handleRelayInbound(
      asWs(ws),
      JSON.stringify({
        type: "relay-request",
        token: "jwt",
        machineId: "m_ghost",
        requestId: "r10",
        payload: { type: "abort" },
      }),
      state,
      deps
    );
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

    handleRelayInbound(
      asWs(ws),
      JSON.stringify({
        type: "relay-request",
        token: "jwt",
        machineId: "m_lock1",
        requestId: "r_lock1",
        payload: { type: "abort" },
      }),
      state,
      deps
    );

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

    handleRelayInbound(
      asWs(ws),
      JSON.stringify({
        type: "pair-request",
        pairingCode: "ABCD2345",
        deviceId: "d",
        deviceName: "P",
      }),
      state,
      deps
    );

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
    handleRelayInbound(
      asWs(ws),
      JSON.stringify({
        type: "daemon-register",
        machineId: "m_other",
        machineName: "Other",
        authToken: hmac("m_other", ts),
        timestamp: ts,
      }),
      state,
      deps
    );

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
    handleRelayInbound(
      asWs(ws),
      JSON.stringify({
        type: "daemon-register",
        machineId: "m_same",
        machineName: "M-m_same",
        authToken: hmac("m_same", ts),
        timestamp: ts,
      }),
      state,
      deps
    );

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
    const browser = {
      readyState: 1,
      sent: [] as any[],
      on() {},
      send(d: any) {
        this.sent.push(d);
      },
      close() {},
    };
    deps.wsTunnelHub.open("ws_r1", browser as any, "m_WA");
    deps.wsTunnelHub.onOpened("ws_r1", "m_WA");

    handleRelayInbound(
      asWs(b.ws),
      JSON.stringify({
        type: "tunnel-ws-data",
        tunnelId: "ws_r1",
        data: "evil",
      }),
      b.state,
      deps
    );
    expect(browser.sent).toHaveLength(0); // 伪造者被 hub 归属校验丢弃

    handleRelayInbound(
      asWs(a.ws),
      JSON.stringify({
        type: "tunnel-ws-data",
        tunnelId: "ws_r1",
        data: "legit",
      }),
      a.state,
      deps
    );
    expect(browser.sent[0]).toBe("legit");
  });
});

describe("RELAY_DISCOVERY=off(纯隧道部署姿态)", () => {
  it("rejects list-machines with an error and does not reveal machines", () => {
    const deps: RouterDeps = { ...makeDeps(), discovery: false };
    const { ws: daemonWs } = registerDaemonVia(deps, "m_disc1");
    cleanups.push(daemonWs);

    const ws = new MockWs();
    const state = createConnState();
    handleRelayInbound(asWs(ws), JSON.stringify({ type: "list-machines" }), state, deps);
    expect(ws.sent.at(-1)).toEqual({ type: "error", error: "Discovery is disabled on this relay" });
    expect(ws.sent.some((m) => m.type === "machines-list")).toBe(false);
  });

  it("rejects pair-request with a failed pair-response (App UI 可显示失败)", () => {
    const deps: RouterDeps = { ...makeDeps(), discovery: false };
    const ws = new MockWs();
    const state = createConnState();
    handleRelayInbound(
      asWs(ws),
      JSON.stringify({
        type: "pair-request",
        pairingCode: "ABCD2345",
        deviceId: "d1",
        deviceName: "Phone",
      }),
      state,
      deps
    );
    expect(ws.sent.at(-1)).toEqual({
      type: "pair-response",
      success: false,
      error: "Pairing is disabled on this relay",
    });
  });

  it("discovery undefined keeps existing behavior (默认开启)", () => {
    const deps = makeDeps();
    const ws = new MockWs();
    const state = createConnState();
    handleRelayInbound(asWs(ws), JSON.stringify({ type: "list-machines" }), state, deps);
    expect(ws.sent.at(-1).type).toBe("machines-list");
  });
});
