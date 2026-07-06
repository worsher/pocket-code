import { describe, it, expect, vi, beforeEach } from "vitest";

const readLocalFile = vi.fn();
const writeLocalFile = vi.fn();
const listLocalFiles = vi.fn();
const getProjectWorkspaceRoot = vi.fn();
const getDefaultWorkspace = vi.fn(() => "file:///doc/workspace");

vi.mock("./localFileSystem", () => ({
  readLocalFile: (...args: unknown[]) => readLocalFile(...args),
  writeLocalFile: (...args: unknown[]) => writeLocalFile(...args),
  listLocalFiles: (...args: unknown[]) => listLocalFiles(...args),
  getProjectWorkspaceRoot: (...args: unknown[]) => getProjectWorkspaceRoot(...args),
  getDefaultWorkspace: () => getDefaultWorkspace(),
}));

import { createDeviceBackend, toRelativePath, parseExecResult } from "./deviceBackend";

describe("toRelativePath", () => {
  it("strips leading slashes produced by safePath('/', ...)", () => {
    expect(toRelativePath("/a/b.ts")).toBe("a/b.ts");
    expect(toRelativePath("/")).toBe(".");
    expect(toRelativePath("/file.txt")).toBe("file.txt");
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

  it("readFile: strips leading slash and resolves against project workspace root", async () => {
    getProjectWorkspaceRoot.mockReturnValue("file:///doc/workspace/proj1");
    readLocalFile.mockResolvedValue({ success: true, content: "hello" });

    const backend = createDeviceBackend({ projectId: "proj1", execTool: vi.fn() });
    const content = await backend.readFile("/a/b.ts");

    expect(readLocalFile).toHaveBeenCalledWith("a/b.ts", "file:///doc/workspace/proj1");
    expect(content).toBe("hello");
  });

  it("readFile: falls back to default workspace when no projectId", async () => {
    getProjectWorkspaceRoot.mockReturnValue(undefined);
    readLocalFile.mockResolvedValue({ success: true, content: "x" });

    const backend = createDeviceBackend({ execTool: vi.fn() });
    await backend.readFile("/f.txt");

    expect(readLocalFile).toHaveBeenCalledWith("f.txt", "file:///doc/workspace");
  });

  it("readFile: throws on failure (registry.run wraps into {success:false})", async () => {
    getProjectWorkspaceRoot.mockReturnValue(undefined);
    readLocalFile.mockResolvedValue({ success: false, error: "not found" });

    const backend = createDeviceBackend({ execTool: vi.fn() });
    await expect(backend.readFile("/missing.txt")).rejects.toThrow("not found");
  });

  it("writeFile: reports isNew:true when the file didn't exist before", async () => {
    getProjectWorkspaceRoot.mockReturnValue(undefined);
    readLocalFile.mockResolvedValue({ success: false, error: "File does not exist" });
    writeLocalFile.mockResolvedValue({ success: true });

    const backend = createDeviceBackend({ execTool: vi.fn() });
    const result = await backend.writeFile("/new.txt", "content");

    expect(result).toEqual({ isNew: true });
    expect(writeLocalFile).toHaveBeenCalledWith("new.txt", "content", "file:///doc/workspace");
  });

  it("writeFile: reports isNew:false when the file already existed", async () => {
    getProjectWorkspaceRoot.mockReturnValue(undefined);
    readLocalFile.mockResolvedValue({ success: true, content: "old" });
    writeLocalFile.mockResolvedValue({ success: true });

    const backend = createDeviceBackend({ execTool: vi.fn() });
    const result = await backend.writeFile("/existing.txt", "new content");

    expect(result).toEqual({ isNew: false });
  });

  it("writeFile: throws on failure", async () => {
    getProjectWorkspaceRoot.mockReturnValue(undefined);
    readLocalFile.mockResolvedValue({ success: false, error: "n/a" });
    writeLocalFile.mockResolvedValue({ success: false, error: "disk full" });

    const backend = createDeviceBackend({ execTool: vi.fn() });
    await expect(backend.writeFile("/x.txt", "y")).rejects.toThrow("disk full");
  });

  it("listFiles: maps 'directory' → 'dir' (core registry contract)", async () => {
    getProjectWorkspaceRoot.mockReturnValue(undefined);
    listLocalFiles.mockResolvedValue({
      success: true,
      items: [{ name: "src", type: "directory" }, { name: "a.ts", type: "file" }],
    });

    const backend = createDeviceBackend({ execTool: vi.fn() });
    const items = await backend.listFiles("/");

    expect(listLocalFiles).toHaveBeenCalledWith(".", "file:///doc/workspace");
    expect(items).toEqual([{ name: "src", type: "dir" }, { name: "a.ts", type: "file" }]);
  });

  it("listFiles: throws on failure", async () => {
    getProjectWorkspaceRoot.mockReturnValue(undefined);
    listLocalFiles.mockResolvedValue({ success: false, error: "no dir" });

    const backend = createDeviceBackend({ execTool: vi.fn() });
    await expect(backend.listFiles("/missing")).rejects.toThrow("no dir");
  });

  it("exec: calls execTool('runCommand', {command}) and normalizes result", async () => {
    const execTool = vi.fn().mockResolvedValue({ success: true, stdout: "out", stderr: "", exitCode: 0 });
    const backend = createDeviceBackend({ execTool });

    const result = await backend.exec("ls -la");

    expect(execTool).toHaveBeenCalledWith("runCommand", { command: "ls -la" });
    expect(result).toEqual({ stdout: "out", stderr: "", exitCode: 0 });
  });

  it("exec: success:false without exitCode normalizes to exitCode 1", async () => {
    const execTool = vi.fn().mockResolvedValue({ success: false, error: "boom" });
    const backend = createDeviceBackend({ execTool });

    const result = await backend.exec("false");

    expect(result).toEqual({ stdout: "", stderr: "boom", exitCode: 1 });
  });

  it("startProcess: calls execTool('runInBackground', ...) and coerces numeric processId to string", async () => {
    const execTool = vi.fn().mockResolvedValue({ success: true, processId: 42 });
    const backend = createDeviceBackend({ execTool });

    const result = await backend.startProcess!("npm run dev", { cwd: "app" });

    expect(execTool).toHaveBeenCalledWith("runInBackground", { command: "npm run dev", cwd: "app" });
    expect(result).toEqual({ processId: "42" });
  });

  it("startProcess: throws on failure", async () => {
    const execTool = vi.fn().mockResolvedValue({ success: false, error: "cannot start" });
    const backend = createDeviceBackend({ execTool });

    await expect(backend.startProcess!("bad-cmd")).rejects.toThrow("cannot start");
  });

  it("stopProcess: calls execTool('stopProcess', ...) coercing string processId back to number", async () => {
    const execTool = vi.fn().mockResolvedValue({ success: true });
    const backend = createDeviceBackend({ execTool });

    await backend.stopProcess!("42");

    expect(execTool).toHaveBeenCalledWith("stopProcess", { processId: 42 });
  });

  it("stopProcess: throws on failure", async () => {
    const execTool = vi.fn().mockResolvedValue({ success: false, error: "not running" });
    const backend = createDeviceBackend({ execTool });

    await expect(backend.stopProcess!("99")).rejects.toThrow("not running");
  });
});
