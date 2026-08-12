import { describe, it, expect } from "vitest";
import { WsMessage } from "./messages.js";

describe("wire — WsMessage validation", () => {
  // ── Valid messages ──

  it("should accept valid register message", () => {
    const result = WsMessage.safeParse({ type: "register", deviceId: "abc123" });
    expect(result.success).toBe(true);
  });

  it("should accept valid init message", () => {
    const result = WsMessage.safeParse({
      type: "init",
      token: "jwt-token",
      sessionId: "sess-1",
      model: "deepseek-v3",
    });
    expect(result.success).toBe(true);
  });

  it("negotiates workspace protocol v2 without rejecting v1 clients", () => {
    expect(WsMessage.safeParse({ type: "init" }).success).toBe(true);
    expect(WsMessage.safeParse({ type: "init", workspaceProtocolVersion: 2 }).success).toBe(true);
    expect(WsMessage.safeParse({ type: "init", workspaceProtocolVersion: 3 }).success).toBe(false);
  });

  it("keeps legacy init gitCredentials parse-compatible", () => {
    expect(
      WsMessage.safeParse({
        type: "init",
        gitCredentials: [
          { platform: "github", host: "github.com", username: "u", token: "legacy-token" },
        ],
      }).success
    ).toBe(true);
  });

  it("carries a legacy lookup key only as optional migration metadata", () => {
    expect(
      WsMessage.safeParse({
        type: "init",
        projectId: "10ed836e-ae48-4d67-9e26-a74cbf55a52e",
        legacyProjectId: "old-project",
      }).success
    ).toBe(true);
    expect(WsMessage.safeParse({ type: "init", legacyProjectId: "x".repeat(129) }).success).toBe(
      false
    );
  });

  it("goal-create / goal-control round-trip (P16)", () => {
    const create = WsMessage.safeParse({
      type: "goal-create",
      content: "清零 lint 错误",
      acceptance: "pnpm lint 通过",
      replace: null,
      maxTurns: 30,
    });
    expect(create.success).toBe(true);
    expect(create.success && (create.data as any).replace).toBeUndefined();
    expect(create.success && (create.data as any).maxTurns).toBe(30);
    expect(WsMessage.safeParse({ type: "goal-create", content: "" }).success).toBe(false);
    expect(WsMessage.safeParse({ type: "goal-create", content: "x", maxTurns: 0 }).success).toBe(
      false
    );

    expect(WsMessage.safeParse({ type: "goal-control", action: "pause" }).success).toBe(true);
    expect(WsMessage.safeParse({ type: "goal-control", action: "resume" }).success).toBe(true);
    expect(WsMessage.safeParse({ type: "goal-control", action: "cancel" }).success).toBe(true);
    expect(WsMessage.safeParse({ type: "goal-control", action: "stop" }).success).toBe(false);
  });

  it("init accepts lastSeq/eventEpoch and coerces null to undefined (P14)", () => {
    const r = WsMessage.safeParse({ type: "init", lastSeq: 417, eventEpoch: "ep_x" });
    expect(r.success && (r.data as any).lastSeq).toBe(417);
    expect(r.success && (r.data as any).eventEpoch).toBe("ep_x");
    const r2 = WsMessage.safeParse({ type: "init", lastSeq: null, eventEpoch: null });
    expect(r2.success && (r2.data as any).lastSeq).toBeUndefined();
    expect(WsMessage.safeParse({ type: "init", lastSeq: -1 }).success).toBe(false);
  });

  it("should accept valid message with images", () => {
    const result = WsMessage.safeParse({
      type: "message",
      content: "analyze this",
      images: [{ base64: "abc", mimeType: "image/png" }],
    });
    expect(result.success).toBe(true);
  });

  it("should accept valid abort message", () => {
    const result = WsMessage.safeParse({ type: "abort" });
    expect(result.success).toBe(true);
  });

  it("validates a generation-guarded writer release", () => {
    expect(
      WsMessage.safeParse({
        type: "workspace-writer-release",
        projectId: "550e8400-e29b-41d4-a716-446655440000",
        replicaId: "3ca2e8bb-4fe5-4e16-a6ca-99840d666870",
        workspaceGeneration: 2,
        _reqId: "release-1",
      }).success
    ).toBe(true);
    expect(
      WsMessage.safeParse({
        type: "workspace-writer-release",
        projectId: "550e8400-e29b-41d4-a716-446655440000",
        replicaId: "3ca2e8bb-4fe5-4e16-a6ca-99840d666870",
        workspaceGeneration: 0,
        _reqId: "release-1",
      }).success
    ).toBe(false);
  });

  it("should accept valid tool-exec message", () => {
    const result = WsMessage.safeParse({
      type: "tool-exec",
      toolName: "readFile",
      args: { path: "test.txt" },
      callId: "call-1",
    });
    expect(result.success).toBe(true);
  });

  // ── Invalid messages ──

  it("should reject unknown message type", () => {
    const result = WsMessage.safeParse({ type: "unknown-type" });
    expect(result.success).toBe(false);
  });

  it("should reject register without deviceId", () => {
    const result = WsMessage.safeParse({ type: "register" });
    expect(result.success).toBe(false);
  });

  it("should reject register with empty deviceId", () => {
    const result = WsMessage.safeParse({ type: "register", deviceId: "" });
    expect(result.success).toBe(false);
  });

  it("should reject message without content", () => {
    const result = WsMessage.safeParse({ type: "message" });
    expect(result.success).toBe(false);
  });

  it("should reject message with empty content", () => {
    const result = WsMessage.safeParse({ type: "message", content: "" });
    expect(result.success).toBe(false);
  });

  it("should reject message with too many images", () => {
    const images = Array.from({ length: 11 }, () => ({
      base64: "abc",
      mimeType: "image/png",
    }));
    const result = WsMessage.safeParse({
      type: "message",
      content: "test",
      images,
    });
    expect(result.success).toBe(false);
  });

  it("should reject tool-exec without toolName", () => {
    const result = WsMessage.safeParse({
      type: "tool-exec",
      args: {},
    });
    expect(result.success).toBe(false);
  });

  it("should reject non-object input", () => {
    const result = WsMessage.safeParse("not an object");
    expect(result.success).toBe(false);
  });

  it("should reject null input", () => {
    const result = WsMessage.safeParse(null);
    expect(result.success).toBe(false);
  });

  it("should accept valid sync-pull (with and without sinceCommit)", () => {
    expect(WsMessage.safeParse({ type: "sync-pull" }).success).toBe(true);
    expect(WsMessage.safeParse({ type: "sync-pull", sinceCommit: "abc123" }).success).toBe(true);
  });

  it("should accept valid sync-file", () => {
    const r = WsMessage.safeParse({ type: "sync-file", commit: "deadbeef", path: "src/a.ts" });
    expect(r.success).toBe(true);
  });

  it("should reject sync-file without commit/path", () => {
    expect(WsMessage.safeParse({ type: "sync-file", path: "a" }).success).toBe(false);
    expect(WsMessage.safeParse({ type: "sync-file", commit: "x" }).success).toBe(false);
  });

  it("validates linked workspace binding requests", () => {
    expect(
      WsMessage.safeParse({
        type: "workspace-bind-linked",
        _reqId: "req-1",
        projectId: "10ed836e-ae48-4d67-9e26-a74cbf55a52e",
        path: "/Users/example/code/project",
      }).success
    ).toBe(true);
    expect(
      WsMessage.safeParse({
        type: "workspace-bind-linked",
        _reqId: "req-1",
        projectId: "not-a-uuid",
        path: "/tmp/project",
      }).success
    ).toBe(false);
  });

  it("validates linked source inspection requests", () => {
    expect(
      WsMessage.safeParse({
        type: "workspace-source-inspect",
        projectId: "10ed836e-ae48-4d67-9e26-a74cbf55a52e",
        _reqId: "source_1",
      }).success
    ).toBe(true);
    expect(
      WsMessage.safeParse({
        type: "workspace-source-inspect",
        projectId: "legacy-project-name",
        _reqId: "source_1",
      }).success
    ).toBe(false);
  });

  it("validates explicit legacy cleanup requests", () => {
    expect(
      WsMessage.safeParse({
        type: "workspace-legacy-cleanup",
        projectId: "10ed836e-ae48-4d67-9e26-a74cbf55a52e",
        legacyProjectId: "old-project",
        _reqId: "legacy_1",
      }).success
    ).toBe(true);
    expect(
      WsMessage.safeParse({
        type: "workspace-legacy-cleanup",
        projectId: "old-project",
        legacyProjectId: "old-project",
        _reqId: "legacy_1",
      }).success
    ).toBe(false);
  });

  it("validates bounded Git credential RPCs", () => {
    const profile = {
      id: "github-main",
      label: "GitHub",
      provider: "github",
      authKind: "pat",
      origin: "https://github.com",
      username: "octocat",
    };
    expect(
      WsMessage.safeParse({
        type: "git-credential-upsert",
        profile,
        secret: "github_pat_example",
        _reqId: "cred_1",
      }).success
    ).toBe(true);
    expect(
      WsMessage.safeParse({
        type: "git-credential-upsert",
        profile,
        sealedSecret: {
          version: 1,
          algorithm: "x25519-xsalsa20-poly1305",
          keyId: "key_1",
          profileId: profile.id,
          origin: profile.origin,
          issuedAt: 123,
          bindingNonce: "nonce_1",
          requestId: "cred_2",
          ephemeralPublicKey: "a".repeat(44),
          nonce: "b".repeat(32),
          ciphertext: "c".repeat(64),
        },
        _reqId: "cred_2",
      }).success
    ).toBe(true);
    expect(
      WsMessage.safeParse({
        type: "git-credential-test",
        credentialProfileId: profile.id,
        repositoryUrl: "https://github.com/acme/private.git",
        capability: "read",
        _reqId: "cred_3",
      }).success
    ).toBe(true);
    expect(
      WsMessage.safeParse({
        type: "git-credential-delete",
        credentialProfileId: profile.id,
        _reqId: "cred_4",
      }).success
    ).toBe(true);

    expect(
      WsMessage.safeParse({
        type: "git-credential-upsert",
        profile: { ...profile, id: "x".repeat(129) },
        secret: "token",
        _reqId: "cred_5",
      }).success
    ).toBe(false);
    expect(
      WsMessage.safeParse({
        type: "git-credential-upsert",
        profile,
        secret: "x".repeat(16385),
        _reqId: "cred_6",
      }).success
    ).toBe(false);
  });

  it("validates remote Git import and workspace operations", () => {
    const projectId = "10ed836e-ae48-4d67-9e26-a74cbf55a52e";
    expect(
      WsMessage.safeParse({
        type: "workspace-import-git",
        projectId,
        displayName: "Private repo",
        repositoryUrl: "https://gitlab.example.com/team/repo.git",
        credentialProfileId: "gitlab-company",
        branch: "main",
        _reqId: "git_import_1",
      }).success
    ).toBe(true);
    expect(
      WsMessage.safeParse({
        type: "git-workspace-operation",
        projectId,
        operation: "commit",
        credentialProfileId: "gitlab-company",
        commitMessage: "Update from Pocket Code",
        _reqId: "git_op_1",
      }).success
    ).toBe(true);
    expect(
      WsMessage.safeParse({
        type: "git-workspace-operation",
        projectId,
        operation: "force-push",
        credentialProfileId: "gitlab-company",
        _reqId: "git_op_2",
      }).success
    ).toBe(false);
  });
});
