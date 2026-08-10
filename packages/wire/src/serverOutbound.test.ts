import { describe, it, expect } from "vitest";
import { ServerOutbound, SessionMsg } from "./serverOutbound.js";

describe("ServerOutbound", () => {
  const valid: unknown[] = [
    { type: "auth", token: "jwt", userId: "u1" },
    { type: "session", sessionId: "s1", projectId: "p1", workspace: "/w" },
    { type: "quota", userId: "u1", tier: "free", limits: {}, usage: {} },
    { type: "file-list", path: ".", _reqId: "r1", success: true, items: [] },
    { type: "file-content", path: "a.ts", success: true, content: "x" },
    {
      type: "sync-manifest",
      commit: "abc",
      parent: null,
      files: [{ path: "a", status: "M" }],
      _reqId: "r2",
    },
    { type: "sync-file-content", path: "a", encoding: "base64", content: "YQ==", _reqId: "r3" },
    { type: "sync-file-content", path: "a", error: "read failed" },
    { type: "sessions-list", sessions: [{ session_id: "s1" }] },
    { type: "session-deleted", sessionId: "s1", success: true },
    { type: "project-workspace-deleted", projectId: "p1", success: false, error: "no sessions" },
    {
      type: "workspace-import-result",
      _reqId: "wi_1",
      status: "imported",
      project: {
        projectId: "10ed836e-ae48-4d67-9e26-a74cbf55a52e",
        displayName: "Linked project",
        replicaId: "0f3d985e-0a3a-458e-932d-c89dbbf671c6",
        workspaceGeneration: 1,
        authorityId: "ce393574-d077-4ddf-a34a-bd9746277f97",
        replicaKind: "dev-binding",
        updatedAt: 100,
      },
      importSource: {
        mode: "linked",
        sourceKind: "directory",
        sourceDeviceId: "ce393574-d077-4ddf-a34a-bd9746277f97",
        canonicalLocator: "/Users/example/code/project",
        identity: {
          importMode: "linked",
          sourceKind: "directory",
          strongKey: "physical-key",
          weakKeys: ["physical-key"],
        },
        importedSnapshot: "1:2",
        importedAt: 100,
        writeBackPolicy: "linked",
      },
    },
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
    expect(ServerOutbound.safeParse({ type: "session-deleted", sessionId: "s1" }).success).toBe(
      false
    ); // 缺 success
  });

  it("session carries eventEpoch/currentSeq; resync-required round-trips (P14)", () => {
    expect(
      SessionMsg.safeParse({
        type: "session",
        sessionId: "s",
        projectId: "",
        workspace: "/w",
        eventEpoch: "ep_1",
        currentSeq: 9,
      }).success
    ).toBe(true);
    const resync = {
      type: "resync-required",
      reason: "epoch-changed",
      eventEpoch: "ep_2",
      currentSeq: 0,
    };
    const r = ServerOutbound.safeParse(resync);
    expect(r.success && r.data).toEqual(resync);
    expect(
      ServerOutbound.safeParse({
        type: "resync-required",
        reason: "other",
        eventEpoch: "e",
        currentSeq: 0,
      }).success
    ).toBe(false);
  });

  it("session optionally carries a server-authoritative workspace scope", () => {
    const scoped = {
      type: "session",
      workspaceProtocolVersion: 2,
      sessionId: "session-1",
      projectId: "10ed836e-ae48-4d67-9e26-a74cbf55a52e",
      workspace: "/w",
      workspaceScope: {
        projectId: "10ed836e-ae48-4d67-9e26-a74cbf55a52e",
        replicaId: "0f3d985e-0a3a-458e-932d-c89dbbf671c6",
        sessionId: "session-1",
        workspaceGeneration: 2,
        authorityId: "ce393574-d077-4ddf-a34a-bd9746277f97",
        replicaKind: "cloud",
      },
      workspaceCatalog: [
        {
          projectId: "10ed836e-ae48-4d67-9e26-a74cbf55a52e",
          displayName: "Remote project",
          replicaId: "0f3d985e-0a3a-458e-932d-c89dbbf671c6",
          workspaceGeneration: 2,
          authorityId: "ce393574-d077-4ddf-a34a-bd9746277f97",
          replicaKind: "cloud",
          updatedAt: 100,
        },
      ],
    };
    const result = SessionMsg.safeParse(scoped);
    expect(result.success && result.data).toEqual(scoped);
    expect(SessionMsg.safeParse({ ...scoped, workspaceProtocolVersion: 3 }).success).toBe(false);
  });
});
