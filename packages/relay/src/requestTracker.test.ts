import { describe, it, expect } from "vitest";
import { RequestTracker } from "./requestTracker.js";

const OPEN = { readyState: 1 };
const CLOSED = { readyState: 3 };

describe("RequestTracker", () => {
  it("tracks a request with its owning machineId, retrieves and deletes it", () => {
    const t = new RequestTracker();
    const ws = { readyState: 1 };
    t.track("r1", ws, "m_A");
    expect(t.get("r1")?.ws).toBe(ws);
    expect(t.get("r1")?.machineId).toBe("m_A");
    expect(t.size).toBe(1);
    t.delete("r1");
    expect(t.get("r1")).toBeUndefined();
    expect(t.size).toBe(0);
  });

  it("deleteBySocket removes all requests for a given socket", () => {
    const t = new RequestTracker();
    const a = { readyState: 1 };
    const b = { readyState: 1 };
    t.track("r1", a, "m_A");
    t.track("r2", a, "m_A");
    t.track("r3", b, "m_B");
    t.deleteBySocket(a);
    expect(t.get("r1")).toBeUndefined();
    expect(t.get("r2")).toBeUndefined();
    expect(t.get("r3")?.ws).toBe(b);
    expect(t.size).toBe(1);
  });

  it("drains every pending request for a daemon while preserving other machines", () => {
    const t = new RequestTracker();
    const a = { readyState: 1 };
    const b = { readyState: 1 };
    t.track("message", a, "m_A", 1, "message");
    t.track("goal", b, "m_A", 2, "goal-control");
    t.track("other", b, "m_B", 3, "message");

    expect(t.drainByMachine("m_A")).toEqual([
      { requestId: "message", ws: a, requestType: "message" },
      { requestId: "goal", ws: b, requestType: "goal-control" },
    ]);
    expect(t.get("message")).toBeUndefined();
    expect(t.get("goal")).toBeUndefined();
    expect(t.get("other")?.machineId).toBe("m_B");
  });

  it("findStale reports closed sockets without silently deleting them", () => {
    const t = new RequestTracker();
    t.track("open", OPEN, "m_A");
    t.track("closed", CLOSED, "m_A");
    const stale = t.findStale();
    expect(stale).toEqual([
      expect.objectContaining({ requestId: "closed", reason: "socket-closed" }),
    ]);
    expect(t.get("open")?.ws).toBe(OPEN);
    expect(t.get("closed")).toBeDefined();
    expect(t.deleteIfMatch(stale[0])).toBe(true);
    expect(t.get("closed")).toBeUndefined();
  });

  it("findStale reports TTL expiry for an open socket so the caller can notify it", () => {
    const t = new RequestTracker(60_000);
    t.track("old", OPEN, "m_A", 1_000);
    t.track("fresh", OPEN, "m_A", 100_000);
    const stale = t.findStale(120_000);
    expect(stale).toEqual([expect.objectContaining({ requestId: "old", reason: "timeout" })]);
    expect(t.get("old")).toBeDefined();
    expect(t.deleteIfMatch(stale[0])).toBe(true);
    expect(t.get("old")).toBeUndefined();
    expect(t.get("fresh")?.ws).toBe(OPEN);
  });

  it("findStale keeps fresh, open entries", () => {
    const t = new RequestTracker(60_000);
    t.track("a", OPEN, "m_A", 100_000);
    expect(t.findStale(110_000)).toEqual([]);
    expect(t.size).toBe(1);
  });

  it("keeps open requests for 30 minutes by default", () => {
    const t = new RequestTracker();
    t.track("long-turn", OPEN, "m_A", 1_000);
    expect(t.findStale(1_000 + 30 * 60 * 1_000)).toEqual([]);
    expect(t.findStale(1_000 + 30 * 60 * 1_000 + 1)).toHaveLength(1);
  });

  it("touch extends the TTL of a live stream", () => {
    const t = new RequestTracker(60_000);
    t.track("stream", OPEN, "m_A", 1_000, "message");
    t.touch("stream", 100_000);
    expect(t.findStale(120_000)).toEqual([]);
    expect(t.get("stream")?.requestType).toBe("message");
  });

  it("does not delete a request that was rebound after a stale snapshot", () => {
    const t = new RequestTracker(100);
    const first = { readyState: 1 };
    const replacement = { readyState: 1 };
    t.track("turn", first, "m_A", 1);
    const [stale] = t.findStale(102);
    t.track("turn", replacement, "m_A", 103);

    expect(t.deleteIfMatch(stale)).toBe(false);
    expect(t.get("turn")?.ws).toBe(replacement);
  });

  it("rebinds a stable request id to a replacement App socket", () => {
    const t = new RequestTracker();
    const first = { readyState: 1 };
    const replacement = { readyState: 1 };
    t.track("turn-1", first, "m_A", 1, "message");
    expect(t.rebind("turn-1", replacement, "m_A", 2)).toBe(true);
    t.markInitPending("turn-1", 2);
    expect(t.get("turn-1")).toMatchObject({
      ws: replacement,
      machineId: "m_A",
      requestType: "message",
      initPending: true,
    });
    expect(t.size).toBe(1);
  });

  it("waits for both same-id init and turn completion in either order", () => {
    const t = new RequestTracker();
    const ws = { readyState: 1 };

    t.track("done-first", ws, "m_A", 1, "message");
    t.markInitPending("done-first", 2);
    t.completeRequest("done-first", 3);
    expect(t.get("done-first")).toMatchObject({ terminalSeen: true, initPending: true });
    t.completeInit("done-first", 4);
    expect(t.get("done-first")).toBeUndefined();

    t.track("ready-first", ws, "m_A", 5, "message");
    t.markInitPending("ready-first", 6);
    t.completeInit("ready-first", 7);
    expect(t.get("ready-first")).toMatchObject({ initPending: false });
    t.completeRequest("ready-first", 8);
    expect(t.get("ready-first")).toBeUndefined();
  });

  it("completes a dedicated init tracker on session-ready", () => {
    const t = new RequestTracker();
    t.track("init-envelope", OPEN, "m_A", 1, "init");
    t.completeInit("init-envelope", 2);
    expect(t.get("init-envelope")).toBeUndefined();
  });

  it("cancel removes the obsolete goal stream but preserves its own response tracker", () => {
    const t = new RequestTracker();
    const app = { readyState: 1 };
    t.track("goal-create", app, "m_A", 1, "goal-create");
    t.track("goal-resume", app, "m_A", 2, "goal-control", "resume");
    t.track("goal-cancel", app, "m_A", 3, "goal-control", "cancel");

    t.deleteOtherGoalStreams(app, "m_A", "goal-cancel");

    expect(t.get("goal-create")).toBeUndefined();
    expect(t.get("goal-resume")).toBeUndefined();
    expect(t.get("goal-cancel")?.requestAction).toBe("cancel");
  });
});
