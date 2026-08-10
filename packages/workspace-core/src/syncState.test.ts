import { describe, expect, it } from "vitest";
import { canAdvanceSyncBase, canTransitionSyncPhase, classifySyncState } from "./syncState.js";

describe("classifySyncState", () => {
  it.each([
    [{ baseSnapshot: "a", localSnapshot: "a", remoteSnapshot: "a" }, "noop"],
    [{ baseSnapshot: "a", localSnapshot: "b", remoteSnapshot: "a" }, "push"],
    [{ baseSnapshot: "a", localSnapshot: "a", remoteSnapshot: "b" }, "pull"],
    [{ baseSnapshot: "a", localSnapshot: "b", remoteSnapshot: "b" }, "converged"],
    [{ baseSnapshot: "a", localSnapshot: "b", remoteSnapshot: "c" }, "conflict"],
    [{ baseSnapshot: null, localSnapshot: "a", remoteSnapshot: null }, "push"],
    [{ baseSnapshot: null, localSnapshot: null, remoteSnapshot: "a" }, "pull"],
    [{ baseSnapshot: null, localSnapshot: "a", remoteSnapshot: "b" }, "conflict"],
    [{ baseSnapshot: "a", localSnapshot: null, remoteSnapshot: "a" }, "unavailable"],
  ] as const)("classifies %o as %s", (snapshots, expected) => {
    expect(classifySyncState(snapshots)).toBe(expected);
  });
});

describe("sync transaction state", () => {
  it("allows only ordered transaction transitions", () => {
    expect(canTransitionSyncPhase("idle", "preparing")).toBe(true);
    expect(canTransitionSyncPhase("preparing", "transferring")).toBe(true);
    expect(canTransitionSyncPhase("transferring", "verifying")).toBe(true);
    expect(canTransitionSyncPhase("verifying", "applying")).toBe(true);
    expect(canTransitionSyncPhase("applying", "committed")).toBe(true);
    expect(canTransitionSyncPhase("transferring", "committed")).toBe(false);
    expect(canTransitionSyncPhase("applying", "failed")).toBe(false);
  });

  it("does not advance the base on partial verification or apply", () => {
    expect(
      canAdvanceSyncBase({
        phase: "committed",
        expectedSnapshot: "next",
        verifiedSnapshot: "next",
        appliedSnapshot: "next",
      })
    ).toBe(true);

    expect(
      canAdvanceSyncBase({
        phase: "failed",
        expectedSnapshot: "next",
        verifiedSnapshot: "next",
        appliedSnapshot: null,
      })
    ).toBe(false);

    expect(
      canAdvanceSyncBase({
        phase: "committed",
        expectedSnapshot: "next",
        verifiedSnapshot: "partial",
        appliedSnapshot: "next",
      })
    ).toBe(false);
  });
});
