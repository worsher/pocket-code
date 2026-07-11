import { describe, expect, it } from "vitest";
import { parseBuilderMsg } from "./types";

describe("parseBuilderMsg", () => {
  it("合法 ready", () => {
    expect(parseBuilderMsg('{"type":"ready"}')).toEqual({ type: "ready" });
  });
  it("合法 resolve(带 id/path/importer)", () => {
    expect(parseBuilderMsg('{"id":1,"type":"resolve","path":"./a","importer":"src/main.tsx"}'))
      .toEqual({ id: 1, type: "resolve", path: "./a", importer: "src/main.tsx" });
  });
  it("合法 dist/done/error", () => {
    expect(parseBuilderMsg('{"type":"dist","path":"assets/main.js","content":"x"}')).not.toBeNull();
    expect(parseBuilderMsg('{"type":"done","warnings":[]}')).not.toBeNull();
    expect(parseBuilderMsg('{"type":"error","message":"boom"}')).not.toBeNull();
  });
  it("非 JSON 返回 null", () => {
    expect(parseBuilderMsg("not json")).toBeNull();
  });
  it("未知 type 返回 null", () => {
    expect(parseBuilderMsg('{"type":"hack"}')).toBeNull();
  });
  it("resolve 缺 id 返回 null", () => {
    expect(parseBuilderMsg('{"type":"resolve","path":"./a","importer":"x"}')).toBeNull();
  });
  it("dist 缺 content 返回 null", () => {
    expect(parseBuilderMsg('{"type":"dist","path":"a.js"}')).toBeNull();
  });
});
