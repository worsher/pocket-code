import { describe, it, expect } from "vitest";
import { ServerOutbound } from "./serverOutbound.js";

describe("ServerOutbound", () => {
  const valid: unknown[] = [
    { type: "auth", token: "jwt", userId: "u1" },
    { type: "session", sessionId: "s1", projectId: "p1", workspace: "/w" },
    { type: "quota", userId: "u1", tier: "free", limits: {}, usage: {} },
    { type: "file-list", path: ".", _reqId: "r1", success: true, items: [] },
    { type: "file-content", path: "a.ts", success: true, content: "x" },
    { type: "sync-manifest", commit: "abc", parent: null, files: [{ path: "a", status: "M" }], _reqId: "r2" },
    { type: "sync-file-content", path: "a", encoding: "base64", content: "YQ==", _reqId: "r3" },
    { type: "sync-file-content", path: "a", error: "read failed" },
    { type: "sessions-list", sessions: [{ session_id: "s1" }] },
    { type: "session-deleted", sessionId: "s1", success: true },
    { type: "project-workspace-deleted", projectId: "p1", success: false, error: "no sessions" },
    { type: "error", error: "boom" },
    // AgentEvent 成员也是 ServerOutbound
    { type: "text-delta", text: "hi" },
    { type: "tool-result", callId: "c1", result: { ok: true } },
    { type: "done" },
  ];
  it.each(valid.map((v) => [(v as any).type, v]))("accepts %s", (_t, v) => {
    expect(ServerOutbound.safeParse(v).success).toBe(true);
  });

  it("rejects unknown type and missing required fields", () => {
    expect(ServerOutbound.safeParse({ type: "nope" }).success).toBe(false);
    expect(ServerOutbound.safeParse({ type: "auth", token: "jwt" }).success).toBe(false); // 缺 userId
    expect(ServerOutbound.safeParse({ type: "session-deleted", sessionId: "s1" }).success).toBe(false); // 缺 success
  });
});
