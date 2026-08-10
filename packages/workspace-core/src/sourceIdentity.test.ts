import { describe, expect, it } from "vitest";
import {
  classifySourceDuplicate,
  deriveSourceIdentity,
  normalizeGitRemote,
} from "./sourceIdentity.js";
import type { ImportMode } from "./types.js";

function directoryIdentity(
  importMode: ImportMode,
  overrides: Partial<Parameters<typeof deriveSourceIdentity>[0]> = {}
) {
  return deriveSourceIdentity({
    importMode,
    sourceKind: "directory",
    sourceDeviceId: "macbook-a",
    stableFileId: "volume-1:inode-42",
    canonicalLocator: "/Users/example/code/project",
    ...overrides,
  });
}

describe("source identity", () => {
  it.each([
    ["git@github.com:Worsher/pocket-code.git", "github.com/Worsher/pocket-code"],
    ["https://github.com/Worsher/pocket-code.git", "github.com/Worsher/pocket-code"],
    ["ssh://git@GitHub.com/Worsher/pocket-code/", "github.com/Worsher/pocket-code"],
  ])("normalizes Git remote %s", (remote, expected) => {
    expect(normalizeGitRemote(remote)).toBe(expected);
  });

  it("strongly deduplicates the same physical linked directory", () => {
    expect(
      classifySourceDuplicate(directoryIdentity("linked"), directoryIdentity("linked"))
    ).toMatchObject({
      strength: "strong",
    });
  });

  it("only warns when an independent copy has the same source", () => {
    expect(
      classifySourceDuplicate(directoryIdentity("copy"), directoryIdentity("copy"))
    ).toMatchObject({
      strength: "weak",
    });
    expect(
      classifySourceDuplicate(directoryIdentity("copy"), directoryIdentity("linked"))
    ).toMatchObject({
      strength: "weak",
    });
  });

  it("does not equate identical path strings from different devices", () => {
    const existing = directoryIdentity("linked", { stableFileId: undefined });
    const candidate = directoryIdentity("linked", {
      sourceDeviceId: "macbook-b",
      stableFileId: undefined,
    });

    expect(classifySourceDuplicate(existing, candidate)).toEqual({ strength: "none" });
  });

  it("does not conflate filesystem IDs with platform handle IDs", () => {
    const existing = directoryIdentity("linked");
    const candidate = directoryIdentity("linked", {
      stableFileId: undefined,
      platformHandleId: "volume-1:inode-42",
    });

    expect(classifySourceDuplicate(existing, candidate)).toMatchObject({
      strength: "weak",
    });
  });

  it("weakly matches the same Git remote across devices and transports", () => {
    const existing = deriveSourceIdentity({
      importMode: "git",
      sourceKind: "git",
      sourceDeviceId: "phone",
      gitRemote: "git@github.com:Worsher/pocket-code.git",
    });
    const candidate = deriveSourceIdentity({
      importMode: "git",
      sourceKind: "git",
      sourceDeviceId: "cloud",
      gitRemote: "https://github.com/Worsher/pocket-code.git",
    });

    expect(classifySourceDuplicate(existing, candidate)).toMatchObject({ strength: "weak" });
  });

  it("requires an actual identity signal", () => {
    expect(() =>
      deriveSourceIdentity({
        importMode: "copy",
        sourceKind: "directory",
        sourceDeviceId: "phone",
      })
    ).toThrow("identity signal");
  });
});
