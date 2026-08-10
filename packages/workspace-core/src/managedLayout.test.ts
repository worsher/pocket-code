import { describe, expect, it } from "vitest";
import { createStorageKey, parseStorageKey } from "./ids.js";
import { getManagedWorkspaceRelativeRoots } from "./managedLayout.js";

const UUID = "550e8400-e29b-41d4-a716-446655440000";

describe("managed workspace layout", () => {
  it("uses a catalog storage key unrelated to the project ID", () => {
    const storageKey = createStorageKey(() => UUID);
    expect(storageKey).toBe("ws_550e8400e29b41d4a716446655440000");
    expect(getManagedWorkspaceRelativeRoots(storageKey)).toEqual({
      projectRoot: `projects/${storageKey}`,
      worktreeRoot: `projects/${storageKey}/worktree`,
      stateRoot: `projects/${storageKey}/state`,
      cacheRoot: `projects/${storageKey}/cache`,
    });
  });

  it.each(["default", "../escape", "ws_deadbeef", "WS_/etc/passwd"])(
    "rejects unsafe or malformed storage key %s",
    (value) => {
      expect(() => parseStorageKey(value)).toThrow("storage key");
      expect(() => getManagedWorkspaceRelativeRoots(value)).toThrow("storage key");
    }
  );
});
