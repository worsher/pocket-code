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
  it("boundary: double slashes, ./ prefix, and reduce-to-root", () => {
    expect(safePath("/ws", "a//b")).toBe("/ws/a/b");
    expect(safePath("/ws", "./a/b")).toBe("/ws/a/b");
    expect(safePath("/ws", "a/..")).toBe("/ws");
  });
  it("boundary: trailing-slash workspace normalizes consistently", () => {
    expect(safePath("/ws/", "a/b.ts")).toBe("/ws/a/b.ts");
    expect(() => safePath("/ws/", "../ws-evil/x")).toThrow("Path traversal not allowed");
  });
  it("boundary: absolute rel degrades to in-workspace path (documented difference vs legacy)", () => {
    expect(safePath("/ws", "/etc/passwd")).toBe("/ws/etc/passwd");
  });
  it("boundary: bare .. escapes and is rejected", () => {
    expect(() => safePath("/ws", "..")).toThrow("Path traversal not allowed");
  });

});
