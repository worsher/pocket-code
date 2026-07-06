import { describe, it, expect, vi } from "vitest";
import { buildToolRegistry } from "./registry.js";
import { resolveGitCwd } from "./execTools.js";
import { makeFakeBackend } from "./fileTools.test.js";

describe("runCommand", () => {
  it("success path slices stdout/stderr", async () => {
    const be = makeFakeBackend({ exec: vi.fn(async () => ({ stdout: "x".repeat(11000), stderr: "", exitCode: 0 })) });
    const r: any = await buildToolRegistry(be, "/ws").run("runCommand", { command: "ls" });
    expect(r.success).toBe(true);
    expect(r.stdout.length).toBe(10000);
  });
  it("non-zero exit yields success:false with stderr", async () => {
    const be = makeFakeBackend({ exec: vi.fn(async () => ({ stdout: "", stderr: "boom", exitCode: 2 })) });
    const r: any = await buildToolRegistry(be, "/ws").run("runCommand", { command: "bad" });
    expect(r).toMatchObject({ success: false, error: "boom" });
  });
});

describe("git tools", () => {
  it("gitStatus execs with HOME isolation and git env", async () => {
    const exec = vi.fn(async () => ({ stdout: "## main", stderr: "", exitCode: 0 }));
    const be = makeFakeBackend({ exec });
    await buildToolRegistry(be, "/ws").run("gitStatus", {});
    const [cmd, opts]: any = exec.mock.calls[0];
    expect(cmd).toContain("git status");
    expect(opts.isolateHome).toBe(true);
    expect(opts.env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("gitClone success path slices stdout to 5000 / stderr to 2000 (gitClone 专属值,非 runCommand 的 10000/5000)", async () => {
    const be = makeFakeBackend({
      exec: vi.fn(async () => ({ stdout: "x".repeat(6000), stderr: "", exitCode: 0 })),
    });
    const r: any = await buildToolRegistry(be, "/ws").run("gitClone", { url: "https://example.com/repo.git" });
    expect(r.success).toBe(true);
    expect(r.stdout.length).toBe(5000);
  });

  it("gitClone rejects a path-traversal target directory", async () => {
    const be = makeFakeBackend();
    const r: any = await buildToolRegistry(be, "/ws").run("gitClone", {
      url: "https://example.com/repo.git",
      dir: "../../evil",
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain("traversal");
  });

  it("gitPush success path slices stdout/stderr to 2000 (symmetric,对照 tools.ts:428)", async () => {
    const be = makeFakeBackend({
      exec: vi.fn(async () => ({ stdout: "x".repeat(3000), stderr: "y".repeat(3000), exitCode: 0 })),
    });
    const r: any = await buildToolRegistry(be, "/ws").run("gitPush", {});
    expect(r.success).toBe(true);
    expect(r.stdout.length).toBe(2000);
    expect(r.stderr.length).toBe(2000);
  });
});

describe("stopProcess schema", () => {
  it("declares processId as string (RuntimeBackend.stopProcess 签名,而非 aiClient 旧 schema 的 number)", () => {
    const registry = buildToolRegistry(
      makeFakeBackend({ startProcess: vi.fn(async () => ({ processId: "p1" })), stopProcess: vi.fn(async () => {}) }),
      "/ws"
    );
    const schema: any = registry.schemas.find((s) => s.name === "stopProcess");
    expect(schema?.parameters.properties?.processId?.type).toBe("string");
  });
});

describe("resolveGitCwd", () => {
  it("returns undefined when workspace root has .git", async () => {
    const be = makeFakeBackend(); // listFiles 默认含 .git
    expect(await resolveGitCwd(be)).toBeUndefined();
  });
  it("finds the single subdirectory containing .git", async () => {
    const listFiles = vi.fn()
      .mockResolvedValueOnce([{ name: "repo", type: "dir" }, { name: "readme.md", type: "file" }])
      .mockResolvedValueOnce([{ name: ".git", type: "dir" }]);
    const be = makeFakeBackend({ listFiles });
    expect(await resolveGitCwd(be)).toBe("repo");
  });
  it("explicit path wins", async () => {
    expect(await resolveGitCwd(makeFakeBackend(), "sub")).toBe("sub");
  });
});

describe("process tools (capability-gated)", () => {
  it("registered only when backend provides startProcess/stopProcess", async () => {
    const noProc = buildToolRegistry(makeFakeBackend(), "/ws");
    expect(noProc.has("runInBackground")).toBe(false);
    const withProc = buildToolRegistry(
      makeFakeBackend({ startProcess: vi.fn(async () => ({ processId: "p1" })), stopProcess: vi.fn(async () => {}) }),
      "/ws"
    );
    expect(withProc.has("runInBackground")).toBe(true);
    const r: any = await withProc.run("runInBackground", { command: "npm run dev" });
    expect(r).toEqual({ success: true, processId: "p1" });
  });
});
