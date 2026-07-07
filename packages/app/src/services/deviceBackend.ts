// ── DeviceBackend ──────────────────────────────────────
// RuntimeBackend 实现,供 App 侧 geek 模式的 runAgentLoop 使用。
// 对照 packages/server/src/nodeBackend.ts(server 侧 RuntimeBackend 实现)。
//
// readFile/writeFile/listFiles → localFileSystem 的 readLocalFile/writeLocalFile/
// listLocalFiles(路径基:调用方传入的 opts.workspaceRoot,单一真相,见
// CreateDeviceBackendOpts 与下方 NEW-2 修复说明)。
// exec → execTool("runCommand", {command}),解析其 {success,stdout,stderr,error} 回
// ExecResult(core registry 的 runCommandTool 按 exitCode===0 判定成功——见
// packages/agent-core/src/tools/execTools.ts runCommandTool)。
// startProcess/stopProcess → execTool("runInBackground"/"stopProcess", ...)(保持 geek
// 现有能力;App 侧 processId 是 number——见 processManager.ts,RuntimeBackend 契约是
// string——见 agent-core/src/tools/execTools.ts stopProcessSchema,这里做双向转换)。
//
// ── 复审修复:放弃 sentinel workspace("/workspace"),改用真实设备工作区根 ──
// 上一轮用哨兵路径("/workspace")绕开 core safePath("/", ...) 的边界 bug,但遗漏了
// 三处真实 shell 泄漏点:
//   1. execTools.ts 的 runCommandTool 恒传 `cwd: workspace`(即哨兵串)给 backend.exec;
//   2. 8 个 git 工具(gitStatus/gitAdd/gitCommit/...)经 resolveGitCwd 在"根即仓库"时
//      仍可能把哨兵串透传为 cwd;
//   3. fileTools.ts 的 searchFilesTool 把 `workspace` 字面拼进 grep 命令字符串
//      (`JSON.stringify(searchPath)`),整个 grep 命令经 backend.exec 交给真实 shell。
// localExecutor.resolveCwd 对以 "/" 开头的 cwd 原样返回(见 localExecutor.ts),不会
// 把哨兵串重新解析回真实根——于是 runCommand/git 在不存在的 "/workspace" 目录下必然
// 失败,searchFiles 拼出的 grep 目标路径在真实文件系统里也不存在。
//
// 修复:workspace 改传真实设备工作区根(调用方——useAgent.ts——算好后同时传给
// runAgentLoop 的 workspace 与 createDeviceBackend 的 workspaceRoot),不再使用
// 任何 sentinel。toRelativePath 剥离的前缀就是这个真实根,exec 的 cwd 翻译也以它
// 为界(见 exec 实现)。
//
// ── 三次复审修复(NEW-2):exec 的 cwd 翻译需同时兼容"原始根"与"归一化根"两种形状 ──
// core 工具(runCommandTool/gitCloneTool/searchFilesTool 等)传给 backend.exec 的
// cwd 是原始 workspace 字符串(真机上形如 `file:///data/.../workspace`,未经
// safePath 归一化),而不是 buildToolRegistry 内部 safePath(root, relPath) 产出的
// 归一化路径。之前的实现只把 opts.cwd 与 normalizedRoot(root)(即 `ws`)比较,
// 导致原始 root 形状的 cwd(两个分支都不匹配)落入 else 原样转发,
// localExecutor.resolveCwd 把 `file:///...`(不以单个 "/" 开头的形态)当相对路径
// 拼接,产出错误 cwd。修复为对 root(原始根)与 ws(归一化根)两种形状都做判断
// (见 exec 实现里的三段 if/else if/else)。
//
// 已知边界(不做处理):当 workspaceMode !== "local" 时,executeTool 会经
// conn.execTool 走 Termux/WS 远端执行,而 searchFiles 拼进 grep 命令里的路径是本
// 设备上的真实路径(如 expo-file-system 的 file:// URI 或本地 workspace 目录),
// 对本地执行器(cwd 缺省即指向 workspace 根)是可用的,但对 Termux/WS 远端文件系统
// 而言这个路径可能并不存在/不匹配。这是本轮修复范围之外的已知限制。
import { safePath } from "@pocket-code/agent-core";
import type { ExecResult, RuntimeBackend } from "@pocket-code/agent-core";
import { readLocalFile, writeLocalFile, listLocalFiles } from "./localFileSystem";

/**
 * core 的 safePath(workspace, ".") 内部先对 `workspace` 做 POSIX 归一化
 * (resolvePosix:按 "/" 切分再拼接,折叠多余的 "/")。真实设备根形如
 * `file:///data/.../workspace` 本身含有 "://" 这种非 POSIX 记号,归一化会把
 * `file:///...` 折成 `/file:/...`(三斜杠被当成路径分隔符压掉)。这意味着
 * registry 内部 safePath(root, relPath) 产出的绝对路径前缀,并不是原始的
 * `root` 字符串,而是"归一化后的 root"。toRelativePath/exec 的 cwd 翻译必须
 * 用同一个归一化结果作比较基准,否则前缀匹配恒失败。用 core 自己导出的
 * safePath(root, ".") 得到这个基准,不在本文件里重复 resolvePosix 逻辑。
 */
function normalizedRoot(root: string): string {
  return safePath(root, ".");
}

/**
 * 把 core safePath(workspaceRoot, path) 产出的绝对路径转换为相对于
 * localFileSystem workspaceRoot 的相对路径。
 *
 * `root` 必须与喂给 runAgentLoop 的 `workspace` 参数、以及
 * `createDeviceBackend` 的 `opts.workspaceRoot` 是同一个真实根(单一真相)。
 * 比较前先对 `root` 做与 core safePath 相同的归一化(见 normalizedRoot)。
 *
 * 边界情况:
 * - 恰好等于归一化后的 root → ""(localFileSystem 把空字符串当作 workspaceRoot 本身)
 * - `${归一化root}/x` → "x"
 * - 不带该前缀的路径(理论上不应出现,防御性兜底):相对路径原样返回,其他
 *   绝对路径退回旧逻辑剥前导 "/"。
 */
export function toRelativePath(fullPath: string, root: string): string {
  const ws = normalizedRoot(root);
  if (fullPath === ws) return "";
  if (fullPath.startsWith(ws + "/")) {
    return fullPath.slice(ws.length + 1);
  }
  // 兜底:未带归一化 root 前缀(不应发生,防御性处理)。
  // 相对路径原样返回;其他绝对路径沿用旧逻辑剥前导 "/"。
  if (!fullPath.startsWith("/")) return fullPath || ".";
  return fullPath.replace(/^\/+/, "") || ".";
}

/** 解析 execTool("runCommand", ...) 的返回值为 core ExecResult。不抛出。 */
export function parseExecResult(result: unknown): ExecResult {
  const r = (result ?? {}) as {
    success?: boolean;
    stdout?: string;
    stderr?: string;
    error?: string;
    exitCode?: number;
  };
  if (typeof r.exitCode === "number") {
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.exitCode };
  }
  if (r.success === false) {
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? r.error ?? "", exitCode: 1 };
  }
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: 0 };
}

export interface CreateDeviceBackendOpts {
  /**
   * 不再被内部使用(Minor 修复:统一改用 workspaceRoot 单源,避免与内部重新求根
   * 的闭包出现"双真相")。字段保留仅为兼容调用方现有传参,不参与路径解析。
   */
  projectId?: string;
  execTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  /**
   * 真实设备工作区根,须与调用方传给 runAgentLoop 的 `workspace` 参数是同一个值
   * (单一真相)。通常是 `getProjectWorkspaceRoot(projectId) ?? getDefaultWorkspace()`。
   * 本文件内部的路径解析(readFile/writeFile/listFiles 的 base、exec 的 cwd
   * 翻译)一律只使用这个传入值,不在内部重新调用 getProjectWorkspaceRoot/
   * getDefaultWorkspace 求根。
   */
  workspaceRoot: string;
}

export function createDeviceBackend(opts: CreateDeviceBackendOpts): RuntimeBackend {
  const { execTool, workspaceRoot: root } = opts;
  const ws = normalizedRoot(root);

  return {
    async readFile(path: string): Promise<string> {
      const rel = toRelativePath(path, root);
      const result = await readLocalFile(rel, root);
      if (!result.success) {
        throw new Error(result.error || "Failed to read file");
      }
      return result.content ?? "";
    },

    async writeFile(path: string, content: string): Promise<{ isNew: boolean }> {
      const rel = toRelativePath(path, root);
      // localFileSystem.writeLocalFile 不返回 isNew;沿用 core writeFileTool 的
      // "写入前先 readFile 探测存在性" 模式来判定(见 fileTools.ts writeFileTool)。
      let isNew = false;
      const before = await readLocalFile(rel, root);
      if (!before.success) isNew = true;

      const result = await writeLocalFile(rel, content, root);
      if (!result.success) {
        throw new Error(result.error || "Failed to write file");
      }
      return { isNew };
    },

    async listFiles(path: string): Promise<{ name: string; type: "file" | "dir" }[]> {
      const rel = toRelativePath(path, root);
      const result = await listLocalFiles(rel, root);
      if (!result.success) {
        throw new Error(result.error || "Failed to list files");
      }
      return (result.items ?? []).map((item) => ({
        name: item.name,
        type: item.type === "directory" ? ("dir" as const) : ("file" as const),
      }));
    },

    // M-obs1 修复:此前完全丢弃 opts,exec 里的 cwd/timeoutMs 调用方设置无效。
    // cwd 翻译(NEW-2 修复:同时兼容原始根/归一化根两种形状):core 的
    // runCommandTool/gitCloneTool/searchFilesTool 等把 `workspace` 参数(**原始**
    // root 字符串,未经 safePath 归一化)或其子路径当作 cwd 传进来;而 8 个 git
    // 工具经 resolveGitCwd 拼出的 cwd 实际是显式传入的 path 原样值、undefined,
    // 或根下恰好命中的一级子目录名(见 execTools.ts resolveGitCwd 语义),并非
    // safePath 归一化后的绝对路径——下面按归一化根(ws)分支处理属前瞻防御,
    // 覆盖 resolveGitCwd 语义未来变化或调用方直传归一化路径的情况。
    // 两者都不是 localFileSystem/executor 认识的相对路径,必须都覆盖到:
    //   - cwd === root(原始根)或 cwd === ws(归一化根) → 不转发 cwd(让
    //     executeLocalTool 的 "runCommand" case 走 args.cwd undefined →
    //     localExecutor.resolveCwd 默认解析到 workspace 根)。
    //   - cwd startsWith root + "/" → 按原始根剥成相对路径转发(如 "sub/dir")。
    //   - cwd startsWith ws + "/" → 按归一化根剥成相对路径转发。
    //   - 其他值(理论上不应出现)原样转发。
    // 真机上 root(如 `file:///data/.../workspace`)与 ws(经 core resolvePosix
    // 折叠三斜杠后如 `/file:/data/.../workspace`)不同,只比较其中一个会让另一个
    // 形状的 cwd 落入 else 原样转发,localExecutor.resolveCwd 把不以单个 "/" 开头
    // 的 `file://...` 当相对路径拼接,产出错误 cwd——这正是 NEW-2 的根因。
    // timeoutMs 透传给 execTool 的 args——"runCommand" 在 localFileSystem.executeLocalTool
    // 里本就读 args.cwd(见该文件 "runCommand" case),timeoutMs 目前
    // executeLocalTool 尚未消费(仍固定 60s 超时),但透传本身对不认识该字段的
    // execTool 实现无害,为将来接入超时打好接口一致性。
    // env/isolateHome:App 侧 execTool 是单一 RPC 通道(本地 executeLocalTool 或
    // Termux WS),既没有进程级 env 注入的口子,也没有"HOME 指向工作区"的沙箱
    // 概念(不像 server 侧那样管理独立进程环境),因此这两个字段在 App 场景下
    // 无对应的下游消费者,不透传。
    async exec(cmd: string, opts?: { cwd?: string; timeoutMs?: number; env?: Record<string, string>; isolateHome?: boolean }): Promise<ExecResult> {
      const args: Record<string, unknown> = { command: cmd };
      if (opts?.cwd !== undefined) {
        if (opts.cwd === root || opts.cwd === ws) {
          // 不转发:executor 默认 cwd 即工作区根。
          // 两种形状都判断:core 传入的 cwd 可能是原始 root(如 execTools.ts
          // runCommandTool 恒传的 `cwd: workspace` 字面量),也可能是经
          // safePath 归一化后的绝对路径(如 resolveGitCwd 拼出的路径)。真实
          // 设备根形如 `file:///data/.../workspace` 时 root !== ws(见
          // normalizedRoot 顶部注释),两者都必须命中才能覆盖真实场景。
        } else if (opts.cwd.startsWith(root + "/")) {
          args.cwd = opts.cwd.slice(root.length + 1);
        } else if (opts.cwd.startsWith(ws + "/")) {
          args.cwd = opts.cwd.slice(ws.length + 1);
        } else {
          args.cwd = opts.cwd;
        }
      }
      if (opts?.timeoutMs !== undefined) args.timeoutMs = opts.timeoutMs;
      const result = await execTool("runCommand", args);
      return parseExecResult(result);
    },

    async startProcess(cmd: string, opts?: { cwd?: string }): Promise<{ processId: string }> {
      const result = (await execTool("runInBackground", {
        command: cmd,
        cwd: opts?.cwd,
      })) as { success?: boolean; processId?: number | string; error?: string };
      if (!result?.success || result.processId === undefined) {
        throw new Error(result?.error || "Failed to start process");
      }
      return { processId: String(result.processId) };
    },

    async stopProcess(processId: string): Promise<void> {
      const numericId = Number(processId);
      const result = (await execTool("stopProcess", {
        processId: Number.isNaN(numericId) ? processId : numericId,
      })) as { success?: boolean; error?: string };
      if (result?.success === false) {
        throw new Error(result.error || "Failed to stop process");
      }
    },
  };
}
