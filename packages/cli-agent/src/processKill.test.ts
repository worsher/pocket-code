import { afterEach, describe, expect, it, vi } from "vitest";

describe("killProcessTree (posix)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("先对进程组发 SIGTERM", async () => {
    if (process.platform === "win32") return; // posix-only 断言
    const { killProcessTree } = await import("./processKill.js");
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    killProcessTree(12345, 3000);
    expect(killSpy).toHaveBeenCalledWith(-12345, "SIGTERM");
  });

  it("pid 非法直接返回不抛", async () => {
    const { killProcessTree } = await import("./processKill.js");
    expect(() => killProcessTree(0)).not.toThrow();
    expect(() => killProcessTree(-5)).not.toThrow();
  });
});

describe("isProcessAlive", () => {
  it("对存活进程(自身)返回 true", async () => {
    const { isProcessAlive } = await import("./processKill.js");
    expect(isProcessAlive(process.pid)).toBe(true);
  });
});
