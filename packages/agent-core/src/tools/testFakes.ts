// 测试专用 fake backend,供 fileTools.test.ts / execTools.test.ts / loop.test.ts 共用。
// 非 .test 后缀 → vitest 不会把本文件当测试套件收集执行。
import { vi } from "vitest";
import type { RuntimeBackend } from "../types.js";

export function makeFakeBackend(over: Partial<RuntimeBackend> = {}): RuntimeBackend {
  const files = new Map<string, string>([["/ws/a.ts", "hello world"]]);
  return {
    readFile: vi.fn(async (p: string) => {
      const c = files.get(p);
      if (c === undefined) throw new Error("ENOENT: " + p);
      return c;
    }),
    writeFile: vi.fn(async (p: string, c: string) => {
      const isNew = !files.has(p);
      files.set(p, c);
      return { isNew };
    }),
    listFiles: vi.fn(async () => [
      { name: "a.ts", type: "file" as const },
      { name: ".git", type: "dir" as const },
    ]),
    exec: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    ...over,
  };
}
