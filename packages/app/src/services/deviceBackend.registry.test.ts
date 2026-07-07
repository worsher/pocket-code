// ── 复审回归集成测试:workspace 改真实设备根消除 sentinel 泄漏 ──
// 上一轮(C1)用 sentinel "/workspace" 修复了 safePath 全拒的问题,但遗漏了三处
// sentinel 会泄漏到真实 shell 的路径:
//   1. execTools.ts 的 runCommandTool 恒传 `cwd: workspace`(sentinel 串)给 backend.exec;
//   2. 8 个 git 工具经 resolveGitCwd,在"根即仓库"场景下同样可能把 sentinel 串当 cwd;
//   3. fileTools.ts 的 searchFilesTool 把 workspace 字面拼进 grep 命令字符串。
// localExecutor.resolveCwd 对以 "/" 开头的 cwd 原样返回(不会把 sentinel 重新解析回真实
// 根),于是 runCommand/git 在不存在的 "/workspace" 目录下必然失败。
//
// 本文件不 mock registry/agent-core 层,只在 localFileSystem 上打桩,用真实
// buildToolRegistry(createDeviceBackend(...), workspaceRoot) 走完整调用链,
// 从而真实复现(旧 sentinel 实现下)/验证(新真实根实现下)这条泄漏链路。
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

import { buildToolRegistry } from "@pocket-code/agent-core";
import { createDeviceBackend } from "./deviceBackend";

const REAL_ROOT = "/doc/workspace";

describe("deviceBackend + real buildToolRegistry (no registry-layer mocks): workspace = real device root", () => {
  beforeEach(() => {
    readLocalFile.mockReset();
    writeLocalFile.mockReset();
    listLocalFiles.mockReset();
    getProjectWorkspaceRoot.mockReset();
    getDefaultWorkspace.mockClear();
  });

  it("registry.run('readFile', ...) succeeds with the real root and forwards the correct relative path", async () => {
    getProjectWorkspaceRoot.mockReturnValue(undefined);
    readLocalFile.mockResolvedValue({ success: true, content: "export const x = 1;" });

    const backend = createDeviceBackend({ execTool: vi.fn(), workspaceRoot: REAL_ROOT });
    const registry = buildToolRegistry(backend, REAL_ROOT);

    const result = await registry.run("readFile", { path: "src/index.ts" });

    expect(result).toMatchObject({ success: true, content: "export const x = 1;" });
    // localFileSystem must receive a workspace-relative path, not an absolute
    // sentinel-prefixed or doubled-slash path.
    expect(readLocalFile).toHaveBeenCalledWith("src/index.ts", REAL_ROOT);
  });

  it("registry.run('writeFile', ...) succeeds with the real root", async () => {
    getProjectWorkspaceRoot.mockReturnValue(undefined);
    readLocalFile.mockResolvedValue({ success: false, error: "File does not exist" });
    writeLocalFile.mockResolvedValue({ success: true });

    const backend = createDeviceBackend({ execTool: vi.fn(), workspaceRoot: REAL_ROOT });
    const registry = buildToolRegistry(backend, REAL_ROOT);

    const result = await registry.run("writeFile", { path: "new.txt", content: "hi" });

    expect(result).toMatchObject({ success: true });
    expect(writeLocalFile).toHaveBeenCalledWith("new.txt", "hi", REAL_ROOT);
  });

  it("registry.run('listFiles', ...) succeeds with the real root at workspace root", async () => {
    getProjectWorkspaceRoot.mockReturnValue(undefined);
    listLocalFiles.mockResolvedValue({ success: true, items: [{ name: "src", type: "directory" }] });

    const backend = createDeviceBackend({ execTool: vi.fn(), workspaceRoot: REAL_ROOT });
    const registry = buildToolRegistry(backend, REAL_ROOT);

    const result = await registry.run("listFiles", { path: "." });

    expect(result).toMatchObject({ success: true });
    // path:"." → safePath(REAL_ROOT, ".") === REAL_ROOT exactly → toRelativePath
    // returns "" per the exact-root boundary spec; localFileSystem's resolveDir
    // treats "" the same as "." (workspace root itself).
    expect(listLocalFiles).toHaveBeenCalledWith("", REAL_ROOT);
  });

  // ── runCommand: 复现/验证 execTools.ts runCommandTool 恒传 cwd:workspace 的泄漏 ──
  it("registry.run('runCommand', ...) forwards args without an absolute/non-existent sentinel cwd (execTool sees no cwd, or a plain relative one)", async () => {
    const execTool = vi.fn().mockResolvedValue({ success: true, stdout: "ok", stderr: "", exitCode: 0 });
    const backend = createDeviceBackend({ execTool, workspaceRoot: REAL_ROOT });
    const registry = buildToolRegistry(backend, REAL_ROOT);

    const result = await registry.run("runCommand", { command: "ls" });

    expect(result).toMatchObject({ success: true });
    expect(execTool).toHaveBeenCalledTimes(1);
    const [toolName, args] = execTool.mock.calls[0] as [string, Record<string, unknown>];
    expect(toolName).toBe("runCommand");
    // Under the old sentinel implementation this would have been an absolute,
    // non-existent path like "/workspace". With the real-root fix, cwd === root
    // is not forwarded at all (executor's default cwd is the workspace root).
    if (args.cwd !== undefined) {
      expect(args.cwd).not.toMatch(/^\//);
    }
  });

  // ── git: 复现/验证 resolveGitCwd 在"根即仓库"场景下透传 workspace(sentinel) 作为 cwd 的泄漏 ──
  it("registry.run('gitStatus', ...) forwards args without an absolute/non-existent sentinel cwd", async () => {
    const execTool = vi.fn().mockResolvedValue({ success: true, stdout: "", stderr: "", exitCode: 0 });
    const backend = createDeviceBackend({ execTool, workspaceRoot: REAL_ROOT });
    const registry = buildToolRegistry(backend, REAL_ROOT);

    // resolveGitCwd(backend, undefined) calls backend.listFiles(".") to detect
    // a .git dir at the workspace root.
    listLocalFiles.mockResolvedValue({ success: true, items: [{ name: ".git", type: "directory" }] });

    const result = await registry.run("gitStatus", {});

    expect(result).toMatchObject({ success: true });
    expect(execTool).toHaveBeenCalledTimes(1);
    const [toolName, args] = execTool.mock.calls[0] as [string, Record<string, unknown>];
    expect(toolName).toBe("runCommand");
    if (args.cwd !== undefined) {
      expect(args.cwd).not.toMatch(/^\//);
    }
  });
});
