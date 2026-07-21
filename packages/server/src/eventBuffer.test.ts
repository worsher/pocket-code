import { describe, it, expect, beforeEach, vi } from "vitest";
import { getSessionStream, _resetStreams, _MAX_EVENTS } from "./eventBuffer.js";
import type { AgentEventType } from "@pocket-code/wire";

const td = (text: string): AgentEventType => ({ type: "text-delta", text });

beforeEach(() => {
  _resetStreams();
});

describe("SessionEventStream", () => {
  it("seq strictly monotonic from 1; publish returns the stored object (C14-1/2)", () => {
    const s = getSessionStream("s1");
    expect(s.seq).toBe(0);
    const e1 = s.publish(td("a"));
    const e2 = s.publish(td("b"));
    const e3 = s.publish(td("c"));
    expect([e1.seq, e2.seq, e3.seq]).toEqual([1, 2, 3]);
    expect(s.seq).toBe(3);
    // readSince 返回的正是入环的同一对象(补发逐字段相等的实现基础,C14-2)
    const backlog = s.readSince(0)!;
    expect(backlog[0]).toBe(e1);
    expect(backlog[2]).toBe(e3);
  });

  it("epoch stable per registry lifetime; same sessionId → same stream", () => {
    const a = getSessionStream("s1");
    const b = getSessionStream("s1");
    expect(b).toBe(a);
    const epoch = a.epoch;
    expect(epoch).toMatch(/^ep_/);
    _resetStreams();
    expect(getSessionStream("s1").epoch).not.toBe(epoch);
  });

  it("readSince boundaries: full / partial / empty tail", () => {
    const s = getSessionStream("s1");
    s.publish(td("a"));
    s.publish(td("b"));
    s.publish(td("c"));
    expect(s.readSince(0)!.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(s.readSince(2)!.map((e) => e.seq)).toEqual([3]);
    expect(s.readSince(3)).toEqual([]);
  });

  it("eviction gap: beyond _MAX_EVENTS the oldest entries drop and coverage returns null (C14-7)", () => {
    const s = getSessionStream("s1");
    for (let i = 0; i < _MAX_EVENTS + 5; i++) s.publish(td(`e${i}`));
    expect(s.seq).toBe(_MAX_EVENTS + 5);
    expect(s.readSince(0)).toBeNull();
    expect(s.readSince(4)).toBeNull(); // 头部已淘汰到 seq 6 起
    const tail = s.readSince(_MAX_EVENTS + 3)!;
    expect(tail.map((e) => e.seq)).toEqual([_MAX_EVENTS + 4, _MAX_EVENTS + 5]);
    // 容量内窗口完整:从头部第一条前一位读起,连续无缺
    const head = s.readSince(5)!;
    expect(head.length).toBe(_MAX_EVENTS);
    expect(head[0].seq).toBe(6);
  });

  it("byte cap evicts whole oldest entries", () => {
    const s = getSessionStream("s1");
    const big = "x".repeat(5 * 1024 * 1024); // ~5MB
    s.publish(td(big));
    s.publish(td(big));
    // 8MB 上限:第二条入环时第一条被整条淘汰 → 覆盖不足
    expect(s.readSince(0)).toBeNull();
    expect(s.readSince(1)!.map((e) => e.seq)).toEqual([2]);
  });

  it("fan-out: subscribers receive published events; unsubscribe stops; a throwing subscriber does not break others", () => {
    const s = getSessionStream("s1");
    const got1: AgentEventType[] = [];
    const got2: AgentEventType[] = [];
    const bad = vi.fn(() => {
      throw new Error("dead socket");
    });
    const un1 = s.subscribe((ev) => got1.push(ev));
    s.subscribe(bad);
    s.subscribe((ev) => got2.push(ev));
    const e1 = s.publish(td("a"));
    expect(got1).toEqual([e1]);
    expect(got2).toEqual([e1]);
    expect(bad).toHaveBeenCalledTimes(1);
    un1();
    s.publish(td("b"));
    expect(got1.length).toBe(1);
    expect(got2.length).toBe(2);
  });
});
