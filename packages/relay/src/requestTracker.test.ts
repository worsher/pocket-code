import { describe, it, expect } from "vitest";
import { RequestTracker } from "./requestTracker.js";

const OPEN = { readyState: 1 };
const CLOSED = { readyState: 3 };

describe("RequestTracker", () => {
  it("tracks and retrieves a request's socket, and deletes it", () => {
    const t = new RequestTracker();
    const ws = { readyState: 1 };
    t.track("r1", ws);
    expect(t.get("r1")).toBe(ws);
    expect(t.size).toBe(1);
    t.delete("r1");
    expect(t.get("r1")).toBeUndefined();
    expect(t.size).toBe(0);
  });

  it("deleteBySocket removes all requests for a given socket", () => {
    const t = new RequestTracker();
    const a = { readyState: 1 };
    const b = { readyState: 1 };
    t.track("r1", a);
    t.track("r2", a);
    t.track("r3", b);
    t.deleteBySocket(a);
    expect(t.get("r1")).toBeUndefined();
    expect(t.get("r2")).toBeUndefined();
    expect(t.get("r3")).toBe(b);
    expect(t.size).toBe(1);
  });

  it("cleanupStale removes entries whose socket is no longer open", () => {
    const t = new RequestTracker();
    t.track("open", OPEN);
    t.track("closed", CLOSED);
    const removed = t.cleanupStale();
    expect(removed).toBe(1);
    expect(t.get("open")).toBe(OPEN);
    expect(t.get("closed")).toBeUndefined();
  });

  it("cleanupStale removes entries older than TTL even if the socket is still open (the leak fix)", () => {
    const t = new RequestTracker(60_000); // 60s TTL
    t.track("old", OPEN, 1_000);
    t.track("fresh", OPEN, 100_000);
    // now = 120_000 → "old" is 119s old (> 60s), "fresh" is 20s old (< 60s)
    const removed = t.cleanupStale(120_000);
    expect(removed).toBe(1);
    expect(t.get("old")).toBeUndefined();
    expect(t.get("fresh")).toBe(OPEN);
  });

  it("cleanupStale keeps fresh, open entries", () => {
    const t = new RequestTracker(60_000);
    t.track("a", OPEN, 100_000);
    expect(t.cleanupStale(110_000)).toBe(0);
    expect(t.size).toBe(1);
  });
});
