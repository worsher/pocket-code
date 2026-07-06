import { describe, it, expect, vi } from "vitest";
import { buildToolRegistry } from "./registry.js";
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

// 注:注册表工具接收 workspace 相对路径;fake backend 里用 /ws 前缀模拟 safePath 结果
describe("file tools", () => {
  const reg = () => buildToolRegistry(makeFakeBackend(), "/ws");

  it("readFile returns content; missing file yields success:false", async () => {
    expect(await reg().run("readFile", { path: "a.ts" })).toEqual({ success: true, content: "hello world" });
    const r: any = await reg().run("readFile", { path: "nope.ts" });
    expect(r.success).toBe(false);
    expect(r.error).toContain("ENOENT");
  });

  it("writeFile returns path+isNew (file-changed 派生依赖)", async () => {
    const r: any = await reg().run("writeFile", { path: "new.ts", content: "x" });
    expect(r).toEqual({ success: true, path: "new.ts", isNew: true });
  });

  it("editFile replaces unique oldText; ambiguous/missing oldText fails", async () => {
    const registry = reg();
    const ok: any = await registry.run("editFile", { path: "a.ts", oldText: "hello", newText: "hi" });
    expect(ok.success).toBe(true);
    const missing: any = await registry.run("editFile", { path: "a.ts", oldText: "zzz", newText: "y" });
    expect(missing.success).toBe(false);
  });

  it("listFiles returns items incl. dot entries", async () => {
    const r: any = await reg().run("listFiles", { path: "." });
    expect(r.items.some((i: any) => i.name === ".git")).toBe(true);
  });

  it("unknown tool yields structured error", async () => {
    expect(await reg().run("nope", {})).toEqual({ success: false, error: "Unknown tool: nope" });
  });

  it("path traversal is rejected via safePath", async () => {
    const r: any = await reg().run("readFile", { path: "../etc/passwd" });
    expect(r.success).toBe(false);
    expect(r.error).toContain("traversal");
  });
});
