import { describe, it, expect, vi } from "vitest";
import { buildToolRegistry } from "./registry.js";
import { makeFakeBackend } from "./testFakes.js";

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

  it("searchFiles with isRegex=false passes -F flag (fixed-string matching)", async () => {
    const exec = vi.fn(async () => ({
      stdout: "/ws/a.ts:1:a.b matches\n",
      stderr: "",
      exitCode: 0,
    }));
    const registry = buildToolRegistry(makeFakeBackend({ exec }), "/ws");
    await registry.run("searchFiles", { pattern: "a.b", isRegex: false });
    expect(exec).toHaveBeenCalled();
    const cmd = (exec.mock.calls as Array<any[]>)[0][0];
    expect(cmd).toContain(" -F ");
    expect(cmd).not.toContain(" -E ");
  });

  it("searchFiles with isRegex=true passes -E flag (extended regex)", async () => {
    const exec = vi.fn(async () => ({
      stdout: "/ws/a.ts:1:match\n",
      stderr: "",
      exitCode: 0,
    }));
    const registry = buildToolRegistry(makeFakeBackend({ exec }), "/ws");
    await registry.run("searchFiles", { pattern: "a+b", isRegex: true });
    expect(exec).toHaveBeenCalled();
    const cmd = (exec.mock.calls as Array<any[]>)[0][0];
    expect(cmd).toContain(" -E ");
    expect(cmd).not.toContain(" -F ");
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

  it("searchFiles with no matches (exitCode:1) returns empty matches, matchCount:0", async () => {
    const exec = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 1 }));
    const registry = buildToolRegistry(makeFakeBackend({ exec }), "/ws");
    const r: any = await registry.run("searchFiles", { pattern: "nope" });
    expect(r).toEqual({ success: true, matchCount: 0, matches: [], truncated: false });
  });

  it("searchFiles with exitCode>1 returns error (C2: grep error handling)", async () => {
    const exec = vi.fn(async () => ({
      stdout: "",
      stderr: "grep: bad pattern",
      exitCode: 2,
    }));
    const registry = buildToolRegistry(makeFakeBackend({ exec }), "/ws");
    const r: any = await registry.run("searchFiles", { pattern: "bad" });
    expect(r.success).toBe(false);
    expect(r.error).toBe("grep: bad pattern");
  });

  it("searchFiles with 60 lines marks truncated=true (I1: line-count cap at 50)", async () => {
    const line = "/ws/a.ts:1:match\n";
    const stdout = line.repeat(60); // 60 lines
    const exec = vi.fn(async () => ({ stdout, stderr: "", exitCode: 0 }));
    const registry = buildToolRegistry(makeFakeBackend({ exec }), "/ws");
    const r: any = await registry.run("searchFiles", { pattern: "match" });
    expect(r.success).toBe(true);
    expect(r.matches.length).toBe(50);
    expect(r.matchCount).toBe(50);
    expect(r.truncated).toBe(true);
  });

  it("searchFiles with 50 lines marks truncated=false (I1: no truncation at boundary)", async () => {
    const line = "/ws/a.ts:1:match\n";
    const stdout = line.repeat(50); // exactly 50 lines
    const exec = vi.fn(async () => ({ stdout, stderr: "", exitCode: 0 }));
    const registry = buildToolRegistry(makeFakeBackend({ exec }), "/ws");
    const r: any = await registry.run("searchFiles", { pattern: "match" });
    expect(r.success).toBe(true);
    expect(r.matches.length).toBe(50);
    expect(r.matchCount).toBe(50);
    expect(r.truncated).toBe(false);
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
