import { describe, it, expect } from "vitest";
import { safePath } from "./safePath.js";

describe("safePath", () => {
  it("resolves relative paths inside the workspace", () => {
    expect(safePath("/ws", "a/b.ts")).toBe("/ws/a/b.ts");
    expect(safePath("/ws", ".")).toBe("/ws");
  });
  it("rejects traversal outside the workspace", () => {
    expect(() => safePath("/ws", "../etc/passwd")).toThrow("Path traversal not allowed");
    expect(() => safePath("/ws", "a/../../x")).toThrow("Path traversal not allowed");
  });
  it("rejects sibling-prefix bypass (/ws-evil)", () => {
    expect(() => safePath("/ws", "../ws-evil/x")).toThrow("Path traversal not allowed");
  });
});
