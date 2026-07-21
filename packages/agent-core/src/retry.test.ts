import { describe, it, expect } from "vitest";
import { retryBackoffDelays, abortableSleep } from "./retry.js";

describe("retryBackoffDelays", () => {
  it("exponential ramp with cap and ≤25% jitter (C13-1)", () => {
    const delays = retryBackoffDelays(10, 500);
    expect(delays.length).toBe(9); // n 次尝试 = n-1 次等待
    delays.forEach((d, i) => {
      const base = Math.min(500 * 2 ** i, 32_000);
      expect(d).toBeGreaterThanOrEqual(base);
      expect(d).toBeLessThanOrEqual(base * 1.25);
    });
  });

  it("maxAttempts 1 → no delays; base override respected", () => {
    expect(retryBackoffDelays(1)).toEqual([]);
    const [first] = retryBackoffDelays(2, 1);
    expect(first).toBeLessThanOrEqual(1.25);
  });
});

describe("abortableSleep", () => {
  it("resolves after ms", async () => {
    await abortableSleep(5); // 不抛即过
  });

  it("rejects promptly on abort; pre-aborted signal rejects immediately", async () => {
    const ac = new AbortController();
    const p = abortableSleep(60_000, ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow();
    const ac2 = new AbortController();
    ac2.abort();
    await expect(abortableSleep(60_000, ac2.signal)).rejects.toThrow();
  });
});
