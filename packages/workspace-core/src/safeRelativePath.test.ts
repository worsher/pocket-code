import { describe, expect, it } from "vitest";
import { normalizeWorkspaceRelativePath } from "./safeRelativePath.js";

describe("normalizeWorkspaceRelativePath", () => {
  it.each([
    ["src/index.ts", "src/index.ts"],
    ["./src//index.ts", "src/index.ts"],
    ["", "."],
    [".", "."],
    ["assets/my file.png", "assets/my file.png"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeWorkspaceRelativePath(input)).toBe(expected);
  });

  it.each([
    "/etc/passwd",
    "../outside",
    "src/../../outside",
    "C:\\Windows\\system.ini",
    "src\\index.ts",
    "file:///etc/passwd",
    "src/\0secret",
  ])("rejects unsafe path %s", (input) => {
    expect(() => normalizeWorkspaceRelativePath(input)).toThrow();
  });

  it.each([
    "%2e%2e/secret",
    "%252e%252e%252fsecret",
    "%2fetc/passwd",
    "C%3a%5cWindows%5csystem.ini",
  ])("rejects encoded traversal %s", (input) => {
    expect(() => normalizeWorkspaceRelativePath(input)).toThrow();
  });

  it("rejects malformed URI encoding before another adapter can decode it", () => {
    expect(() => normalizeWorkspaceRelativePath("src/%ZZ/file.ts")).toThrow(
      "malformed URI encoding"
    );
  });
});
