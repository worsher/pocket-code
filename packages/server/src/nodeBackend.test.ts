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
});
