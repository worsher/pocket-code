import { describe, it, expect, vi, beforeEach } from "vitest";

const readLocalFile = vi.fn();
const writeLocalFile = vi.fn();
const listLocalFiles = vi.fn();
const getProjectWorkspaceRoot = vi.fn();
const getDefaultWorkspace = vi.fn(() => "/doc/workspace");

vi.mock("./localFileSystem", () => ({
  readLocalFile: (...args: unknown[]) => readLocalFile(...args),
  writeLocalFile: (...args: unknown[]) => writeLocalFile(...args),
  listLocalFiles: (...args: unknown[]) => listLocalFiles(...args),
  getProjectWorkspaceRoot: (...args: unknown[]) => getProjectWorkspaceRoot(...args),
  getDefaultWorkspace: () => getDefaultWorkspace(),
}));

import { createDeviceBackend, toRelativePath, parseExecResult } from "./deviceBackend";

// A plain POSIX-style absolute path is already idempotent under core's
// safePath/resolvePosix normalization (no "://" to collapse), which keeps most
// tests below simple. A couple of tests further down exercise the real
// `file:///...` URI shape returned by expo-file-system's Directory.uri, which
// core's safePath normalizes by collapsing the triple slash (see
// deviceBackend.ts's `normalizedRoot` for why toRelativePath/exec must compare
// against the *normalized* root, not the raw workspaceRoot string).
const DEFAULT_ROOT = "/doc/workspace";
const PROJ_ROOT = "/doc/workspace/proj1";

describe("toRelativePath", () => {
  it("strips the real workspace root prefix", () => {
    expect(toRelativePath(`${DEFAULT_ROOT}/a/b.ts`, DEFAULT_ROOT)).toBe("a/b.ts");
    expect(toRelativePath(`${DEFAULT_ROOT}/file.txt`, DEFAULT_ROOT)).toBe("file.txt");
  });

  it("exactly the workspace root maps to ''", () => {
    expect(toRelativePath(DEFAULT_ROOT, DEFAULT_ROOT)).toBe("");
  });

  it("returns relative (non-absolute) paths unchanged", () => {
    expect(toRelativePath("src/index.ts", DEFAULT_ROOT)).toBe("src/index.ts");
    expect(toRelativePath(".", DEFAULT_ROOT)).toBe(".");
  });

  it("falls back to stripping leading slashes for absolute paths without the root prefix (defensive)", () => {
    expect(toRelativePath("/a/b.ts", DEFAULT_ROOT)).toBe("a/b.ts");
    expect(toRelativePath("/", DEFAULT_ROOT)).toBe(".");
    expect(toRelativePath("/file.txt", DEFAULT_ROOT)).toBe("file.txt");
  });

  it("normalizes a file:// URI root the same way core's safePath does (collapses the triple slash)", () => {
    // core's safePath(workspace, ".") runs workspace through a POSIX
    // resolve/normalize pass that treats "/" as the only separator, so
    // "file:///data/workspace" (a real expo-file-system Directory.uri) folds
    // down to "/file:/data/workspace". toRelativePath must strip that
    // *normalized* prefix, not the raw "file:///data/workspace" string.
    const fileUriRoot = "file:///data/workspace";
    const producedByCoreSafePath = "/file:/data/workspace/src/index.ts";
    expect(toRelativePath(producedByCoreSafePath, fileUriRoot)).toBe("src/index.ts");
  });
});

describe("parseExecResult", () => {
  it("uses exitCode directly when present", () => {
    expect(parseExecResult({ stdout: "ok", stderr: "", exitCode: 0 })).toEqual({
      stdout: "ok", stderr: "", exitCode: 0,
    });
    expect(parseExecResult({ stdout: "", stderr: "boom", exitCode: 2 })).toEqual({
      stdout: "", stderr: "boom", exitCode: 2,
    });
  });
  it("falls back to exitCode 1 when success:false and no exitCode given", () => {
    expect(parseExecResult({ success: false, error: "nope" })).toEqual({
      stdout: "", stderr: "nope", exitCode: 1,
    });
  });
  it("prefers stderr over error when both present and no exitCode", () => {
    expect(parseExecResult({ success: false, stderr: "stderr-msg", error: "err-msg" })).toEqual({
      stdout: "", stderr: "stderr-msg", exitCode: 1,
    });
  });
  it("treats missing success/exitCode as success (exitCode 0)", () => {
    expect(parseExecResult({ stdout: "hi" })).toEqual({ stdout: "hi", stderr: "", exitCode: 0 });
  });
  it("handles undefined/null result", () => {
    expect(parseExecResult(undefined)).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  });
});

describe("createDeviceBackend", () => {
  beforeEach(() => {
    readLocalFile.mockReset();
    writeLocalFile.mockReset();
    listLocalFiles.mockReset();
    getProjectWorkspaceRoot.mockReset();
    getDefaultWorkspace.mockClear();
  });

  it("readFile: strips the real workspace root prefix and resolves against project workspace root", async () => {
    getProjectWorkspaceRoot.mockReturnValue(PROJ_ROOT);
    readLocalFile.mockResolvedValue({ success: true, content: "hello" });

    const backend = createDeviceBackend({ projectId: "proj1", execTool: vi.fn(), workspaceRoot: PROJ_ROOT });
    const content = await backend.readFile(`${PROJ_ROOT}/a/b.ts`);

    expect(readLocalFile).toHaveBeenCalledWith("a/b.ts", PROJ_ROOT);
    expect(content).toBe("hello");
  });

  it("readFile: falls back to default workspace when no projectId", async () => {
    getProjectWorkspaceRoot.mockReturnValue(undefined);
    readLocalFile.mockResolvedValue({ success: true, content: "x" });

    const backend = createDeviceBackend({ execTool: vi.fn(), workspaceRoot: DEFAULT_ROOT });
    await backend.readFile(`${DEFAULT_ROOT}/f.txt`);

    expect(readLocalFile).toHaveBeenCalledWith("f.txt", DEFAULT_ROOT);
  });

  it("readFile: throws on failure (registry.run wraps into {success:false})", async () => {
    getProjectWorkspaceRoot.mockReturnValue(undefined);
    readLocalFile.mockResolvedValue({ success: false, error: "not found" });

    const backend = createDeviceBackend({ execTool: vi.fn(), workspaceRoot: DEFAULT_ROOT });
    await expect(backend.readFile(`${DEFAULT_ROOT}/missing.txt`)).rejects.toThrow("not found");
  });

  it("writeFile: reports isNew:true when the file didn't exist before", async () => {
    getProjectWorkspaceRoot.mockReturnValue(undefined);
    readLocalFile.mockResolvedValue({ success: false, error: "File does not exist" });
    writeLocalFile.mockResolvedValue({ success: true });

    const backend = createDeviceBackend({ execTool: vi.fn(), workspaceRoot: DEFAULT_ROOT });
    const result = await backend.writeFile(`${DEFAULT_ROOT}/new.txt`, "content");

    expect(result).toEqual({ isNew: true });
    expect(writeLocalFile).toHaveBeenCalledWith("new.txt", "content", DEFAULT_ROOT);
  });

  it("writeFile: reports isNew:false when the file already existed", async () => {
    getProjectWorkspaceRoot.mockReturnValue(undefined);
    readLocalFile.mockResolvedValue({ success: true, content: "old" });
    writeLocalFile.mockResolvedValue({ success: true });

    const backend = createDeviceBackend({ execTool: vi.fn(), workspaceRoot: DEFAULT_ROOT });
    const result = await backend.writeFile(`${DEFAULT_ROOT}/existing.txt`, "new content");

    expect(result).toEqual({ isNew: false });
  });

  it("writeFile: throws on failure", async () => {
    getProjectWorkspaceRoot.mockReturnValue(undefined);
    readLocalFile.mockResolvedValue({ success: false, error: "n/a" });
    writeLocalFile.mockResolvedValue({ success: false, error: "disk full" });

    const backend = createDeviceBackend({ execTool: vi.fn(), workspaceRoot: DEFAULT_ROOT });
    await expect(backend.writeFile(`${DEFAULT_ROOT}/x.txt`, "y")).rejects.toThrow("disk full");
  });

  it("listFiles: maps 'directory' → 'dir' (core registry contract)", async () => {
    getProjectWorkspaceRoot.mockReturnValue(undefined);
    listLocalFiles.mockResolvedValue({
      success: true,
      items: [{ name: "src", type: "directory" }, { name: "a.ts", type: "file" }],
    });

    const backend = createDeviceBackend({ execTool: vi.fn(), workspaceRoot: DEFAULT_ROOT });
    const items = await backend.listFiles(DEFAULT_ROOT);

    expect(listLocalFiles).toHaveBeenCalledWith("", DEFAULT_ROOT);
    expect(items).toEqual([{ name: "src", type: "dir" }, { name: "a.ts", type: "file" }]);
  });

  it("listFiles: throws on failure", async () => {
    getProjectWorkspaceRoot.mockReturnValue(undefined);
    listLocalFiles.mockResolvedValue({ success: false, error: "no dir" });

    const backend = createDeviceBackend({ execTool: vi.fn(), workspaceRoot: DEFAULT_ROOT });
    await expect(backend.listFiles(`${DEFAULT_ROOT}/missing`)).rejects.toThrow("no dir");
  });

  it("exec: calls execTool('runCommand', {command}) and normalizes result", async () => {
    const execTool = vi.fn().mockResolvedValue({ success: true, stdout: "out", stderr: "", exitCode: 0 });
    const backend = createDeviceBackend({ execTool, workspaceRoot: DEFAULT_ROOT });

    const result = await backend.exec("ls -la");

    expect(execTool).toHaveBeenCalledWith("runCommand", { command: "ls -la" });
    expect(result).toEqual({ stdout: "out", stderr: "", exitCode: 0 });
  });

  it("exec: success:false without exitCode normalizes to exitCode 1", async () => {
    const execTool = vi.fn().mockResolvedValue({ success: false, error: "boom" });
    const backend = createDeviceBackend({ execTool, workspaceRoot: DEFAULT_ROOT });

    const result = await backend.exec("false");

    expect(result).toEqual({ stdout: "", stderr: "boom", exitCode: 1 });
  });

  it("M-obs1: exec forwards opts.timeoutMs and a non-root cwd to execTool args", async () => {
    const execTool = vi.fn().mockResolvedValue({ success: true, stdout: "", stderr: "", exitCode: 0 });
    const backend = createDeviceBackend({ execTool, workspaceRoot: DEFAULT_ROOT });

    await backend.exec("npm test", { cwd: "app", timeoutMs: 5000 });

    expect(execTool).toHaveBeenCalledWith("runCommand", { command: "npm test", cwd: "app", timeoutMs: 5000 });
  });

  it("M-obs1: exec omits cwd/timeoutMs from args when not provided", async () => {
    const execTool = vi.fn().mockResolvedValue({ success: true, stdout: "", stderr: "", exitCode: 0 });
    const backend = createDeviceBackend({ execTool, workspaceRoot: DEFAULT_ROOT });

    await backend.exec("ls");

    expect(execTool).toHaveBeenCalledWith("runCommand", { command: "ls" });
  });

  it("exec: cwd === workspaceRoot is not forwarded (executor default cwd is the workspace root)", async () => {
    const execTool = vi.fn().mockResolvedValue({ success: true, stdout: "", stderr: "", exitCode: 0 });
    const backend = createDeviceBackend({ execTool, workspaceRoot: DEFAULT_ROOT });

    await backend.exec("git status --porcelain", { cwd: DEFAULT_ROOT, timeoutMs: 10000 });

    expect(execTool).toHaveBeenCalledWith("runCommand", { command: "git status --porcelain", timeoutMs: 10000 });
  });

  it("exec: cwd under workspaceRoot is stripped to a relative path before forwarding", async () => {
    const execTool = vi.fn().mockResolvedValue({ success: true, stdout: "", stderr: "", exitCode: 0 });
    const backend = createDeviceBackend({ execTool, workspaceRoot: DEFAULT_ROOT });

    await backend.exec("git status --porcelain", { cwd: `${DEFAULT_ROOT}/sub`, timeoutMs: 10000 });

    expect(execTool).toHaveBeenCalledWith("runCommand", { command: "git status --porcelain", cwd: "sub", timeoutMs: 10000 });
  });

  it("startProcess: calls execTool('runInBackground', ...) and coerces numeric processId to string", async () => {
    const execTool = vi.fn().mockResolvedValue({ success: true, processId: 42 });
    const backend = createDeviceBackend({ execTool, workspaceRoot: DEFAULT_ROOT });

    const result = await backend.startProcess!("npm run dev", { cwd: "app" });

    expect(execTool).toHaveBeenCalledWith("runInBackground", { command: "npm run dev", cwd: "app" });
    expect(result).toEqual({ processId: "42" });
  });

  it("startProcess: throws on failure", async () => {
    const execTool = vi.fn().mockResolvedValue({ success: false, error: "cannot start" });
    const backend = createDeviceBackend({ execTool, workspaceRoot: DEFAULT_ROOT });

    await expect(backend.startProcess!("bad-cmd")).rejects.toThrow("cannot start");
  });

  it("stopProcess: calls execTool('stopProcess', ...) coercing string processId back to number", async () => {
    const execTool = vi.fn().mockResolvedValue({ success: true });
    const backend = createDeviceBackend({ execTool, workspaceRoot: DEFAULT_ROOT });

    await backend.stopProcess!("42");

    expect(execTool).toHaveBeenCalledWith("stopProcess", { processId: 42 });
  });

  it("stopProcess: throws on failure", async () => {
    const execTool = vi.fn().mockResolvedValue({ success: false, error: "not running" });
    const backend = createDeviceBackend({ execTool, workspaceRoot: DEFAULT_ROOT });

    await expect(backend.stopProcess!("99")).rejects.toThrow("not running");
  });
});
