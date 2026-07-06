// ── C1 回归集成测试:workspace sentinel 修 safePath 全拒 ──
// 审查发现:useAgent 里 runAgentLoop 的 workspace 传 "/",而 agent-core 的
// safePath(workspace, relativePath) 守卫是 `full !== ws && !full.startsWith(ws + "/")`。
// 当 workspace="/" 时 ws="/",ws+"/" === "//",几乎任何正常路径的 full(如 "/a/b.ts")
// 都不满足 `full === ws` 也不 startsWith("//") → 每次都抛 "Path traversal not allowed"。
// 这条测试特意不 mock registry/agent-core 层,只在 localFileSystem 上打桩,用真实
// buildToolRegistry(createDeviceBackend(...), workspace) 走一条完整的 readFile 调用链,
// 从而真实复现(修复前)/验证(修复后)这个 bug。
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

import { buildToolRegistry } from "@pocket-code/agent-core";
import { createDeviceBackend, GEEK_WORKSPACE } from "./deviceBackend";

describe("C1: geek workspace sentinel + real buildToolRegistry (no registry-layer mocks)", () => {
  beforeEach(() => {
    readLocalFile.mockReset();
    writeLocalFile.mockReset();
    listLocalFiles.mockReset();
    getProjectWorkspaceRoot.mockReset();
    getDefaultWorkspace.mockClear();
  });

  it("registry.run('readFile', ...) succeeds with GEEK_WORKSPACE and forwards the correct relative path", async () => {
    getProjectWorkspaceRoot.mockReturnValue(undefined);
    readLocalFile.mockResolvedValue({ success: true, content: "export const x = 1;" });

    const backend = createDeviceBackend({ execTool: vi.fn() });
    const registry = buildToolRegistry(backend, GEEK_WORKSPACE);

    const result = await registry.run("readFile", { path: "src/index.ts" });

    expect(result).toMatchObject({ success: true, content: "export const x = 1;" });
    // localFileSystem must receive a workspace-relative path, not an absolute
    // "/workspace/src/index.ts" or a doubled-slash path.
    expect(readLocalFile).toHaveBeenCalledWith("src/index.ts", "file:///doc/workspace");
  });

  it("registry.run('writeFile', ...) succeeds with GEEK_WORKSPACE", async () => {
    getProjectWorkspaceRoot.mockReturnValue(undefined);
    readLocalFile.mockResolvedValue({ success: false, error: "File does not exist" });
    writeLocalFile.mockResolvedValue({ success: true });

    const backend = createDeviceBackend({ execTool: vi.fn() });
    const registry = buildToolRegistry(backend, GEEK_WORKSPACE);

    const result = await registry.run("writeFile", { path: "new.txt", content: "hi" });

    expect(result).toMatchObject({ success: true });
    expect(writeLocalFile).toHaveBeenCalledWith("new.txt", "hi", "file:///doc/workspace");
  });

  it("registry.run('listFiles', ...) succeeds with GEEK_WORKSPACE at root", async () => {
    getProjectWorkspaceRoot.mockReturnValue(undefined);
    listLocalFiles.mockResolvedValue({ success: true, items: [{ name: "src", type: "directory" }] });

    const backend = createDeviceBackend({ execTool: vi.fn() });
    const registry = buildToolRegistry(backend, GEEK_WORKSPACE);

    const result = await registry.run("listFiles", { path: "." });

    expect(result).toMatchObject({ success: true });
    // path:"." → safePath(GEEK_WORKSPACE, ".") === GEEK_WORKSPACE exactly →
    // toRelativePath returns "" per the exact-root boundary spec; localFileSystem's
    // resolveDir treats "" the same as "." (workspace root itself).
    expect(listLocalFiles).toHaveBeenCalledWith("", "file:///doc/workspace");
  });
});
