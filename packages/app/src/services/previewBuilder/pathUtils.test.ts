import { describe, expect, it } from "vitest";
import { dirnamePosix, normalizeImport } from "./pathUtils";

describe("dirnamePosix", () => {
  it("常规路径取目录", () => {
    expect(dirnamePosix("src/a/b.ts")).toBe("src/a");
  });
  it("顶层文件目录为空串", () => {
    expect(dirnamePosix("a.ts")).toBe("");
  });
});

describe("normalizeImport", () => {
  it("同目录相对引用", () => {
    expect(normalizeImport("src/main.tsx", "./App.tsx")).toBe("src/App.tsx");
  });
  it("上级目录引用并折叠", () => {
    expect(normalizeImport("src/pages/Home.tsx", "../lib/util.ts")).toBe("src/lib/util.ts");
  });
  it("以 / 开头视为工作区根", () => {
    expect(normalizeImport("src/main.tsx", "/src/style.css")).toBe("src/style.css");
  });
  it("越出根返回 null", () => {
    expect(normalizeImport("main.tsx", "../../etc/passwd")).toBeNull();
  });
  it("多余 ./ 与重复斜杠折叠", () => {
    expect(normalizeImport("src/main.tsx", ".//./App.tsx")).toBe("src/App.tsx");
  });
});
