import { describe, expect, it } from "vitest";
import { isHttpUrl, isRelative, esmShUrl, joinHttpUrl } from "./bareImports";

const PKG = JSON.stringify({
  dependencies: { react: "^18.3.1", "react-dom": "^18.3.1", "@tanstack/react-query": "5.0.0" },
  devDependencies: { vite: "^5.0.0" },
});

describe("isHttpUrl / isRelative", () => {
  it("http(s) 判定", () => {
    expect(isHttpUrl("https://esm.sh/react")).toBe(true);
    expect(isHttpUrl("./a.ts")).toBe(false);
  });
  it("相对/绝对路径判定", () => {
    expect(isRelative("./a.ts")).toBe(true);
    expect(isRelative("../a.ts")).toBe(true);
    expect(isRelative("/src/a.ts")).toBe(true);
    expect(isRelative("react")).toBe(false);
  });
});

describe("esmShUrl", () => {
  it("依赖表有版本则带版本", () => {
    expect(esmShUrl("react", PKG)).toBe("https://esm.sh/react@^18.3.1");
  });
  it("子路径拼在版本后", () => {
    expect(esmShUrl("react-dom/client", PKG)).toBe("https://esm.sh/react-dom@^18.3.1/client");
  });
  it("scoped 包名取前两段", () => {
    expect(esmShUrl("@tanstack/react-query", PKG)).toBe("https://esm.sh/@tanstack/react-query@5.0.0");
  });
  it("devDependencies 也查得到", () => {
    expect(esmShUrl("vite", PKG)).toBe("https://esm.sh/vite@^5.0.0");
  });
  it("查无版本则不带", () => {
    expect(esmShUrl("lodash", PKG)).toBe("https://esm.sh/lodash");
  });
  it("pkgJson null/非法 JSON 不带版本", () => {
    expect(esmShUrl("react", null)).toBe("https://esm.sh/react");
    expect(esmShUrl("react", "{oops")).toBe("https://esm.sh/react");
  });
});

describe("joinHttpUrl", () => {
  it("绝对路径 spec 拼 origin", () => {
    expect(joinHttpUrl("https://esm.sh/react@18.3.1", "/react@18.3.1/es2022/react.mjs"))
      .toBe("https://esm.sh/react@18.3.1/es2022/react.mjs");
  });
  it("./ 相对 base 路径目录", () => {
    expect(joinHttpUrl("https://esm.sh/react@18.3.1/es2022/react.mjs", "./jsx-runtime.mjs"))
      .toBe("https://esm.sh/react@18.3.1/es2022/jsx-runtime.mjs");
  });
  it("../ 上跳一级", () => {
    expect(joinHttpUrl("https://esm.sh/a/b/c.mjs", "../d.mjs")).toBe("https://esm.sh/a/d.mjs");
  });
  it("越出根返回 null;非 http base 返回 null", () => {
    expect(joinHttpUrl("https://esm.sh/a.mjs", "../../x.mjs")).toBeNull();
    expect(joinHttpUrl("not-a-url", "./x")).toBeNull();
  });
});
