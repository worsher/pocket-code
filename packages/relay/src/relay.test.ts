import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  registerDaemon,
  unregisterDaemon,
  updateHeartbeat,
  getOnlineMachines,
  forwardToDaemon,
  forwardPairRequest,
  forwardPairResponse,
  cleanupStaleDaemons,
} from "./relay.js";
import { WebSocket } from "ws";

// Mock WebSocket
class MockWebSocket {
  readyState = WebSocket.OPEN;
  sent: any[] = [];
  closeCalled = false;
  
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  
  close() {
    this.closeCalled = true;
    this.readyState = 3 as any;
  }
}

describe("Relay Routing & Discovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Clear all by registering and unregistering — but since state is module-global,
    // let's just make sure we unregister mock sockets.
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should register and list online daemons", () => {
    const ws1 = new MockWebSocket() as unknown as WebSocket;
    const ws2 = new MockWebSocket() as unknown as WebSocket;

    registerDaemon(ws1, "m_1", "MacBook");
    registerDaemon(ws2, "m_2", "iMac");

    const machines = getOnlineMachines();
    const m1 = machines.find((m) => m.machineId === "m_1");
    const m2 = machines.find((m) => m.machineId === "m_2");

    expect(m1).toBeDefined();
    expect(m1?.machineName).toBe("MacBook");
    expect(m1?.online).toBe(true);

    expect(m2).toBeDefined();

    unregisterDaemon(ws1);
    unregisterDaemon(ws2);
  });

  it("should forward business requests tightly to the target daemon", () => {
    const daemonWs = new MockWebSocket() as unknown as WebSocket;
    registerDaemon(daemonWs, "m_target", "Target");

    const appPayload = { type: "list-files", path: "/" };
    
    const sent = forwardToDaemon("m_target", "req_123", "fake_jwt", appPayload);
    
    expect(sent).toBe(true);
    const mockWs = daemonWs as unknown as MockWebSocket;
    expect(mockWs.sent.length).toBe(1);
    expect(mockWs.sent[0]).toEqual({
      type: "forward-request",
      token: "fake_jwt",
      requestId: "req_123",
      payload: appPayload
    });

    unregisterDaemon(daemonWs);
  });

  it("should return false when forwarding to an unknown daemon", () => {
    const sent = forwardToDaemon("m_nowhere", "req_999", "jwt", { type: "hello" });
    expect(sent).toBe(false);
  });

  it("should handle the pairing request/response flow correctly", () => {
    const daemonWs = new MockWebSocket() as unknown as WebSocket;
    registerDaemon(daemonWs, "m_pair", "PairingTarget");

    const appWs = new MockWebSocket() as unknown as WebSocket;

    // 1. App sends PairRequest
    const pairForwarded = forwardPairRequest(
      appWs,
      "123456",
      "iphone_1",
      "My iPhone"
      // not specifying machineId, relies on being the only daemon online
    );

    expect(pairForwarded).toBe(true);
    const mDaemonWs = daemonWs as unknown as MockWebSocket;
    expect(mDaemonWs.sent.length).toBe(1);
    expect(mDaemonWs.sent[0].type).toBe("pair-request");
    expect(mDaemonWs.sent[0].pairingCode).toBe("123456");

    // 2. Daemon sends PairResponse
    const responsePayload = { type: "pair-response", success: true, token: "xxx" };
    const resForwarded = forwardPairResponse("m_pair", responsePayload);

    expect(resForwarded).toBe(true);
    const mAppWs = appWs as unknown as MockWebSocket;
    expect(mAppWs.sent.length).toBe(1);
    expect(mAppWs.sent[0]).toEqual(responsePayload);

    unregisterDaemon(daemonWs);
  });

  it("should cleanup stale daemons after heartbeat timeout", () => {
    const daemonWs = new MockWebSocket() as unknown as WebSocket;
    registerDaemon(daemonWs, "m_stale", "Stale");

    // 10 seconds pass, heartbeat updated (simulating ping)
    vi.advanceTimersByTime(10 * 1000);
    updateHeartbeat("m_stale");

    // 50 more seconds pass (60s total, but only 50s since last heartbeat) -> should SURVIVE
    vi.advanceTimersByTime(50 * 1000);
    cleanupStaleDaemons();
    expect(getOnlineMachines().some(m => m.machineId === "m_stale")).toBe(true);

    // 11 more seconds pass without heartbeat (61s since last) -> should DIE
    vi.advanceTimersByTime(11 * 1000);
    cleanupStaleDaemons();
    expect(getOnlineMachines().some(m => m.machineId === "m_stale")).toBe(false);
    expect((daemonWs as unknown as MockWebSocket).closeCalled).toBe(true);
  });
});
