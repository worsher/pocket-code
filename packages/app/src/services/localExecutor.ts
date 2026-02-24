/**
 * localExecutor.ts
 *
 * 统一的本地命令执行层。
 * - 自动检测 proot 是否可用，有则走完整 Linux 环境；否则降级到 Android 原生 shell
 * - 工作目录 cwd 自动拼接 workspace 前缀（如果传入相对路径）
 * - 超时控制（默认 30s）
 * - stdout 超长时截断并标记 `truncated`
 */
import { requireNativeModule } from "expo-modules-core";
import { Paths, Directory } from "expo-file-system";
import { getRuntimeStatus, buildProotCommand } from "./runtimeManager";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ExecResult {
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
    /** true if stdout was truncated due to length limit */
    truncated: boolean;
}

export interface ExecOptions {
    /** 超时毫秒数，默认 30000 */
    timeout?: number;
    /** 额外环境变量 */
    env?: Record<string, string>;
    /** stdout 字符数上限，超过则截断，默认 10000 */
    maxStdoutLength?: number;
}

// ── Config ────────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_STDOUT = 10_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * 获取 workspace 根目录（绝对路径，不带 file:// 前缀）。
 */
export function getWorkspaceDir(): string {
    return new Directory(Paths.document.uri || "", "workspace").uri.replace("file://", "");
}

/**
 * 将用户传入的 cwd（可能是相对路径）解析为绝对路径。
 * 相对路径相对于 workspace 根目录。
 */
function resolveCwd(cwd?: string): string {
    const workspace = getWorkspaceDir();
    if (!cwd) return workspace;
    if (cwd.startsWith("/")) return cwd;
    return `${workspace}/${cwd}`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * 执行命令。
 *
 * 路由逻辑：
 *   1. 如果 proot + rootfs 均可用 → 通过 proot 在 Alpine 环境执行（支持 python3/node/npm 等）
 *   2. 否则 → 降级到 /system/bin/sh（仅基本命令）
 *
 * @param command  - Shell 命令字符串（支持管道/重定向等）
 * @param cwd      - 工作目录（可绝对/可相对 workspace）
 * @param options  - 超时、环境变量、stdout 截断配置
 */
export async function exec(
    command: string,
    cwd?: string,
    options: ExecOptions = {}
): Promise<ExecResult> {
    const {
        timeout = DEFAULT_TIMEOUT_MS,
        maxStdoutLength = DEFAULT_MAX_STDOUT,
    } = options;

    const resolvedCwd = resolveCwd(cwd);

    // Check runtime availability
    const status = await getRuntimeStatus();
    const useProot = status.prootAvailable && status.rootfsInstalled;

    // Build actual command
    const actualCommand = useProot
        ? buildProotCommand(command, resolvedCwd)
        : command;

    const actualCwd = useProot ? "/" : resolvedCwd;

    // Execute via native module
    const mod = requireNativeModule("PocketTerminalModule");

    let result: { success: boolean; stdout: string; stderr: string; exitCode: number };

    // Wrap with a Promise.race for timeout enforcement
    const execPromise = mod.runLocalCommand(actualCommand, actualCwd) as Promise<typeof result>;
    const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`命令超时 (${timeout}ms): ${command}`)), timeout)
    );

    try {
        result = await Promise.race([execPromise, timeoutPromise]);
    } catch (e: any) {
        return {
            success: false,
            stdout: "",
            stderr: e.message ?? String(e),
            exitCode: -1,
            truncated: false,
        };
    }

    // Truncate stdout if too long
    const truncated = result.stdout.length > maxStdoutLength;
    const stdout = truncated
        ? result.stdout.slice(0, maxStdoutLength) + "\n... [输出已截断，超过 " + maxStdoutLength + " 字符]"
        : result.stdout;

    return {
        success: result.success,
        stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        truncated,
    };
}

/**
 * 获取当前执行环境信息（用于注入 AI system prompt）。
 * 返回一段人类可读的描述，例如：
 *   "本地 Android Shell (proot + Alpine Linux 3.19.1，已安装: python3, nodejs, npm)"
 *   "本地 Android Shell (仅基本命令，未安装 proot 环境)"
 */
export async function getExecutionEnvironmentDescription(): Promise<string> {
    const status = await getRuntimeStatus();
    if (status.prootAvailable && status.rootfsInstalled) {
        const pkgs =
            status.installedPackages.length > 0
                ? status.installedPackages.join(", ")
                : "python3, nodejs, npm (建议安装)";
        return `本地 Android Shell (proot + Alpine Linux ${status.rootfsVersion}，已安装: ${pkgs})`;
    }
    return "本地 Android Shell (仅基本命令；未配置 proot 执行环境，运行 Python/Node.js 需先安装)";
}
