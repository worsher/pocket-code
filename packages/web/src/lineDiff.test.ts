import { describe, expect, it } from "vitest";
import { computeLineDiff } from "./lineDiff";

describe("computeLineDiff", () => {
  it("marks all lines add for new file (empty old)", () => {
    expect(computeLineDiff("", "a\nb")).toEqual([
      { kind: "add", text: "a" },
      { kind: "add", text: "b" },
    ]);
  });

  it("computes minimal add/del around common lines", () => {
    expect(computeLineDiff("a\nb\nc", "a\nx\nc")).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "x" },
      { kind: "same", text: "c" },
    ]);
  });
});
