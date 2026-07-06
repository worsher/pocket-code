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

  it("writeFile creating a new file: no oldContent, has newContent (file-changed 派生依赖)", async () => {
    const r: any = await reg().run("writeFile", { path: "new.ts", content: "x" });
    expect(r).toEqual({ success: true, path: "new.ts", isNew: true, newContent: "x" });
    expect(r).not.toHaveProperty("oldContent");
  });

  it("writeFile overwriting an existing file: includes oldContent+newContent", async () => {
    const r: any = await reg().run("writeFile", { path: "a.ts", content: "bye world" });
    expect(r).toEqual({
      success: true,
      path: "a.ts",
      isNew: false,
      oldContent: "hello world",
      newContent: "bye world",
    });
  });

  it("editFile replaces unique oldText; ambiguous/missing oldText fails", async () => {
    const registry = reg();
    const ok: any = await registry.run("editFile", { path: "a.ts", oldText: "hello", newText: "hi" });
    expect(ok).toEqual({
      success: true,
      path: "a.ts",
      isNew: false,
      replaced: 1,
      oldContent: "hello world",
      newContent: "hi world",
    });
    const missing: any = await registry.run("editFile", { path: "a.ts", oldText: "zzz", newText: "y" });
    expect(missing.success).toBe(false);
  });

  it("listFiles maps backend dir→directory (App FileTreeView 判 directory)", async () => {
    const r: any = await reg().run("listFiles", { path: "." });
    expect(r.items).toEqual([
      { name: "a.ts", type: "file" },
      { name: ".git", type: "directory" },
    ]);
  });

  it("searchFiles parses grep output into matches + matchCount + truncated", async () => {
    const exec = vi.fn(async () => ({
      stdout: "/ws/a.ts:1:hello world\n/ws/b.ts:3:say hello\n",
      stderr: "",
      exitCode: 0,
    }));
    const registry = buildToolRegistry(makeFakeBackend({ exec }), "/ws");
    const r: any = await registry.run("searchFiles", { pattern: "hello" });
    expect(r).toEqual({
      success: true,
      matchCount: 2,
      matches: [
        { file: "a.ts", line: 1, content: "hello world" },
        { file: "b.ts", line: 3, content: "say hello" },
      ],
      truncated: false,
    });
  });

  it("searchFiles with no matches returns empty matches, matchCount:0", async () => {
    const exec = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 1 }));
    const registry = buildToolRegistry(makeFakeBackend({ exec }), "/ws");
    const r: any = await registry.run("searchFiles", { pattern: "nope" });
    expect(r).toEqual({ success: true, matchCount: 0, matches: [], truncated: false });
  });

  it("searchFiles marks truncated when stdout exceeds 2000-char cap", async () => {
    const line = "/ws/a.ts:1:" + "x".repeat(50) + "\n";
    const stdout = line.repeat(60); // well over 2000 chars
    const exec = vi.fn(async () => ({ stdout, stderr: "", exitCode: 0 }));
    const registry = buildToolRegistry(makeFakeBackend({ exec }), "/ws");
    const r: any = await registry.run("searchFiles", { pattern: "x" });
    expect(r.success).toBe(true);
    expect(r.truncated).toBe(true);
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
