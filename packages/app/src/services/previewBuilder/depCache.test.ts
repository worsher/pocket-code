import { describe, expect, it } from "vitest";
import { fnv1aHex, cacheKeyForUrl } from "./depCache";

describe("fnv1aHex", () => {
  it("已知向量", () => {
    // FNV-1a 32-bit 标准向量
    expect(fnv1aHex("")).toBe("811c9dc5");
    expect(fnv1aHex("a")).toBe("e40c292c");
    expect(fnv1aHex("foobar")).toBe("bf9cf968");
  });
  it("不同输入不同输出", () => {
    expect(fnv1aHex("https://esm.sh/react@18")).not.toBe(fnv1aHex("https://esm.sh/react@19"));
  });
});

describe("cacheKeyForUrl", () => {
  it("哈希+可读尾段(@ 不在安全字符集,被清洗)", () => {
    const key = cacheKeyForUrl("https://esm.sh/react@18.3.1");
    expect(key).toMatch(/^[0-9a-f]{8}-react18\.3\.1$/);
  });
  it("尾段只留安全字符且截断", () => {
    const key = cacheKeyForUrl("https://esm.sh/@scope/pkg@1.0.0/sub/path?target=es2022&x=" + "y".repeat(100));
    const tail = key.slice(9);
    expect(tail.length).toBeLessThanOrEqual(40);
    expect(tail).toMatch(/^[a-zA-Z0-9._-]+$/);
  });
  it("尾段为空退化为 dep", () => {
    expect(cacheKeyForUrl("https://esm.sh/")).toMatch(/^[0-9a-f]{8}-dep$/);
  });
});
