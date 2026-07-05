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

  it("cleanupStale removes entries whose socket is no longer open", () => {
    const t = new RequestTracker();
    t.track("open", OPEN, "m_A");
    t.track("closed", CLOSED, "m_A");
    const removed = t.cleanupStale();
    expect(removed).toBe(1);
    expect(t.get("open")?.ws).toBe(OPEN);
    expect(t.get("closed")).toBeUndefined();
  });

  it("cleanupStale removes entries older than TTL even if the socket is still open (the leak fix)", () => {
    const t = new RequestTracker(60_000);
    t.track("old", OPEN, "m_A", 1_000);
    t.track("fresh", OPEN, "m_A", 100_000);
    const removed = t.cleanupStale(120_000);
    expect(removed).toBe(1);
    expect(t.get("old")).toBeUndefined();
    expect(t.get("fresh")?.ws).toBe(OPEN);
  });

  it("cleanupStale keeps fresh, open entries", () => {
    const t = new RequestTracker(60_000);
    t.track("a", OPEN, "m_A", 100_000);
    expect(t.cleanupStale(110_000)).toBe(0);
    expect(t.size).toBe(1);
  });
});
