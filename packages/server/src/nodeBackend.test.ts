import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeBackend } from "./nodeBackend.js";

let ws: string;
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), "pc-nb-")); });

describe("NodeBackend", () => {
  it("write/read/list round trip incl. dot entries and isNew", async () => {
    const be = createNodeBackend(ws);
    expect((await be.writeFile(join(ws, "a/b.ts"), "hi")).isNew).toBe(true);
    expect((await be.writeFile(join(ws, "a/b.ts"), "hi2")).isNew).toBe(false);
    expect(await be.readFile(join(ws, "a/b.ts"))).toBe("hi2");
    writeFileSync(join(ws, ".hidden"), "");
    const items = await be.listFiles(ws);
    expect(items.some((i) => i.name === ".hidden")).toBe(true);
    expect(items.find((i) => i.name === "a")?.type).toBe("dir");
  });

  it("exec returns exitCode without throwing on failure", async () => {
    const be = createNodeBackend(ws);
    const ok = await be.exec("echo hi");
    expect(ok).toMatchObject({ exitCode: 0 });
    expect(ok.stdout.trim()).toBe("hi");
    const bad = await be.exec("exit 3");
    expect(bad.exitCode).toBe(3);
  });

  it("isolateHome points HOME at the workspace", async () => {
    const be = createNodeBackend(ws);
    const r = await be.exec("echo $HOME", { isolateHome: true });
    expect(r.stdout.trim()).toBe(ws);
  });

  it("cwd option runs relative to workspace subdir", async () => {
    const be = createNodeBackend(ws);
    await be.exec("mkdir sub && echo x > sub/f.txt");
    const r = await be.exec("ls", { cwd: "sub" });
    expect(r.stdout).toContain("f.txt");
  });

  // C3 回归:对照 execTools.ts runCommand/gitClone 的真实调用形态——
  // 它们直传 { cwd: workspace }(绝对路径)，而非 resolveGitCwd 产出的相对子目录名。
  // 修复前 join(workspace, absPath) 会拼出 "<ws><ws>" 不存在目录 → ENOENT 被吞成 exitCode 1。
  it("exec with absolute cwd equal to workspace works (execTools runCommand/gitClone shape)", async () => {
    const be = createNodeBackend(ws);
    const r = await be.exec("echo hi", { cwd: ws });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("hi");
  });

  it("exec with relative cwd still works (regression)", async () => {
    const be = createNodeBackend(ws);
    await be.exec("mkdir sub");
    const r = await be.exec("pwd", { cwd: "sub" });
    expect(r.exitCode).toBe(0);
    // macOS 下 tmpdir() 可能是 /var 到 /private/var 的符号链接，pwd 打印 realpath，
    // 因此断言路径以 "/sub" 结尾并包含 workspace 目录名，而非严格相等。
    expect(r.stdout.trim().endsWith("/sub")).toBe(true);
    expect(r.stdout).toContain(ws.split("/").pop()!);
  });

  // C1 回归:timeout 归一为 exitCode 124，stderr 可诊断出是被杀掉的。
  it("exec times out and returns exitCode 124 with killed marker in stderr", async () => {
    const be = createNodeBackend(ws);
    const r = await be.exec("sleep 3", { timeoutMs: 150 });
    expect(r.exitCode).toBe(124);
    expect(r.stderr).toContain("killed");
  }, 10000);

  // C1 回归:cwd 子目录不存在 → ENOENT，不再笼统兜底 exitCode 1，
  // 归一为 127 且 stderr 携带诊断信息(err.message)。
  it("exec with nonexistent cwd subdir returns exitCode 127 with diagnosable stderr", async () => {
    const be = createNodeBackend(ws);
    const r = await be.exec("echo hi", { cwd: join(ws, "does-not-exist") });
    expect(r.exitCode).toBe(127);
    expect(r.stderr.length).toBeGreaterThan(0);
  });
});
