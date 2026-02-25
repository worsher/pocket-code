/**
 * runtimeManager.ts
 *
 * 负责管理本地执行环境：检测 rootfs 安装状态、Alpine rootfs 下载/解压、包安装。
 * 解压使用纯 JVM 实现（extractTarGz），完全绕过 Android SELinux 执行限制。
 *
 * 使用 expo-file-system v19 class-based API (Paths, File, Directory)。
 */
import { Paths, File, Directory } from "expo-file-system";
import { requireNativeModule } from "expo-modules-core";
import { extractTarGz } from "pocket-terminal-module";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RuntimeStatus {
    /** Alpine rootfs 已下载并解压（proot 实际上不再使用，此字段保留接口兼容性） */
    prootAvailable: boolean;
    /** Alpine minirootfs 已下载并解压 */
    rootfsInstalled: boolean;
    /** rootfs 版本 (e.g. "3.19.1") */
    rootfsVersion: string;
    /** 已安装的包列表 */
    installedPackages: string[];
}

export type ProgressCallback = (percent: number, message?: string) => void;

// ── Config ────────────────────────────────────────────────────────────────────

const ALPINE_VERSION = "3.19.1";
const ALPINE_ARCH = "aarch64"; // Android ARM64
const ALPINE_ROOTFS_URL = `https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VERSION.split(".").slice(0, 2).join(".")}/releases/${ALPINE_ARCH}/alpine-minirootfs-${ALPINE_VERSION}-${ALPINE_ARCH}.tar.gz`;

const INSTALLED_MANIFEST = "installed-packages.json";

// ── Directory helpers ─────────────────────────────────────────────────────────

function getRootfsDir(): Directory {
    return new Directory(Paths.document.uri || "", "rootfs");
}

function getManifestFile(): File {
    return new File(Paths.document.uri || "", INSTALLED_MANIFEST);
}

function getTarGzFile(): File {
    return new File(Paths.document.uri || "", "alpine-minirootfs.tar.gz");
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * 获取当前运行时状态。
 * prootAvailable 现在与 rootfsInstalled 保持一致（proot 已不再作为前置条件）。
 */
export async function getRuntimeStatus(): Promise<RuntimeStatus> {
    // Read installed packages manifest - also serves as rootfsInstalled indicator
    // (manifest is written after successful extraction in bootstrapRootfs)
    let installedPackages: string[] = [];
    let rootfsVersion = "";
    let rootfsInstalled = false;

    try {
        const manifestFile = getManifestFile();
        if (manifestFile.exists) {
            rootfsInstalled = true;
            const raw = await manifestFile.text();
            const parsed = JSON.parse(raw);
            installedPackages = parsed.packages ?? [];
            rootfsVersion = parsed.version ?? ALPINE_VERSION;
        }
    } catch {
        // Ignore parse errors - rootfsInstalled stays false
    }

    return {
        // prootAvailable is now always true on Android (JVM-based extraction, no proot needed)
        prootAvailable: true,
        rootfsInstalled,
        rootfsVersion: rootfsInstalled ? rootfsVersion || ALPINE_VERSION : "",
        installedPackages,
    };
}

/**
 * 下载并解压 Alpine minirootfs 到 app 内部存储。
 * 使用纯 JVM tar.gz 解压（Kotlin 实现），不依赖 proot 或 shell 执行。
 */
export async function bootstrapRootfs(onProgress?: ProgressCallback): Promise<void> {
    const rootfsDir = getRootfsDir();
    const binSh = new File(rootfsDir, "bin/sh");

    if (binSh.exists) return; // Already installed

    onProgress?.(0, "下载 Alpine rootfs (~4MB)...");

    // Ensure rootfs directory exists
    if (!rootfsDir.exists) {
        rootfsDir.create({ intermediates: true });
    }

    // Download via fetch → save as binary file
    const response = await fetch(ALPINE_ROOTFS_URL);
    if (!response.ok) {
        throw new Error(`下载 Alpine rootfs 失败 (HTTP ${response.status})`);
    }

    onProgress?.(30, "下载完成，写入文件...");

    const arrayBuf = await response.arrayBuffer();
    const tarGzFile = getTarGzFile();
    tarGzFile.write(new Uint8Array(arrayBuf));

    onProgress?.(50, "解压 rootfs（JVM 原生解压）...");

    // Use pure JVM extractTarGz that handles Alpine's absolute symlinks correctly
    const tarPath = tarGzFile.uri.replace("file://", "");
    const destPath = rootfsDir.uri.replace("file://", "");

    try {
        const result = await extractTarGz(tarPath, destPath);
        if (!result.success) {
            throw new Error(`解压失败: ${result.error}`);
        }
    } finally {
        if (tarGzFile.exists) {
            tarGzFile.delete();
        }
    }

    onProgress?.(90, "初始化包管理器...");

    // Write /etc/resolv.conf so apk can resolve DNS inside proot.
    // Android doesn't use /etc/resolv.conf, so Alpine rootfs has none by default.
    const resolvConf = new File(rootfsDir, "etc/resolv.conf");
    resolvConf.write("nameserver 8.8.8.8\nnameserver 1.1.1.1\n");

    // Write version manifest
    const manifestFile = getManifestFile();
    manifestFile.write(
        JSON.stringify({ version: ALPINE_VERSION, packages: [] })
    );

    onProgress?.(100, "完成");
}

/**
 * 在 proot rootfs 内安装包（通过 apk add）。
 * 注意：由于 proot 在 Android 10+ 上因 SELinux 无法执行，此方法暂时受限。
 * 我们仍然保留 proot 包裹命令的构建，以备后续在豁免设备上使用。
 */
export async function installPackage(
    packages: string[]
): Promise<{ success: boolean; output: string }> {
    const status = await getRuntimeStatus();
    if (!status.rootfsInstalled) {
        return { success: false, output: "rootfs 未安装，请先运行 bootstrapRootfs()" };
    }

    const pkgList = packages.join(" ");

    try {
        const mod = requireNativeModule("PocketTerminalModule");
        const rootfsPath = getRootfsDir().uri.replace("file://", "");
        const workspaceDir = new Directory(Paths.document.uri || "", "workspace").uri.replace("file://", "");

        // Get proot full path from nativeLibraryDir
        const nativeLibDir = mod.getNativeLibDir?.();
        if (!nativeLibDir) {
            return { success: false, output: "无法获取 proot 路径 (nativeLibDir 为空)" };
        }
        const prootBin = `${nativeLibDir}/libproot.so`;
        const prootLoaderBin = `${nativeLibDir}/libproot-loader.so`;
        const prootTmpDir = Paths.cache.uri.replace("file://", "") + "proot-tmp";

        // Use export (not env) to pass PROOT_LOADER/PROOT_TMP_DIR — Android toybox env
        // can misinterpret proot flags. Alpine rootfs has its own busybox; do NOT bind
        // Android system binaries (they need bionic libc).
        const apkCmd = `export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; apk update && apk add --no-cache ${pkgList}`;
        const command = [
            `mkdir -p "${prootTmpDir}"`,
            `&&`,
            `export PROOT_TMP_DIR="${prootTmpDir}"`,
            `&&`,
            `export PROOT_LOADER="${prootLoaderBin}"`,
            `&&`,
            `"${prootBin}"`,
            `--rootfs="${rootfsPath}"`,
            `--bind=/dev`,
            `--bind=/proc`,
            `--bind=/sys`,
            `-w /`,
            `-0`,
            `/bin/sh -c '${apkCmd}'`,
        ].join(" ");

        const result = await mod.runLocalCommand(command, "/") as {
            success: boolean;
            stdout: string;
            stderr: string;
        };

        if (result.success) {
            const newPackages = [...status.installedPackages, ...packages];
            const manifestFile = getManifestFile();
            manifestFile.write(
                JSON.stringify({
                    version: status.rootfsVersion || ALPINE_VERSION,
                    packages: Array.from(new Set(newPackages)),
                })
            );
        }

        return {
            success: result.success,
            output: result.stdout + (result.stderr ? "\n" + result.stderr : ""),
        };
    } catch (e: any) {
        return { success: false, output: e.message ?? String(e) };
    }
}

/**
 * 构建 proot 包裹命令字符串。供 localExecutor.ts 使用。
 *
 * 使用 nativeLibDir 中的完整 libproot.so 路径（而非裸命令名 "proot"），
 * 并设置 PROOT_LOADER / PROOT_TMP_DIR 环境变量，绕过 Android SELinux W^X 限制。
 */
export function buildProotCommand(cmd: string, cwd: string): string {
    const mod = requireNativeModule("PocketTerminalModule");
    const nativeLibDir: string = mod.getNativeLibDir?.() ?? "";
    const prootBin = `${nativeLibDir}/libproot.so`;
    const prootLoaderBin = `${nativeLibDir}/libproot-loader.so`;
    const prootTmpDir = Paths.cache.uri.replace("file://", "") + "proot-tmp";
    const rootfsDir = getRootfsDir().uri.replace("file://", "");
    // Strip trailing slash — Directory.uri may include one, which causes
    // proot "can't sanitize binding" warnings and incorrect cwd mapping.
    const workspaceDir = new Directory(Paths.document.uri || "", "workspace").uri
        .replace("file://", "")
        .replace(/\/$/, "");

    // Map host workspace path → /workspace inside container.
    // Use startsWith(workspaceDir + "/") or exact match to avoid false prefix hits.
    let resolvedCwd: string;
    if (cwd === workspaceDir || cwd.startsWith(workspaceDir + "/")) {
        resolvedCwd = "/workspace" + cwd.slice(workspaceDir.length);
    } else {
        resolvedCwd = cwd;
    }
    // Normalize: collapse // and strip trailing /.
    resolvedCwd = resolvedCwd.replace(/\/\//g, "/").replace(/\/\.$/, "") || "/workspace";

    // 在 Alpine /bin/sh 内先注入正确 PATH，确保 apk/node/python3 等可被找到
    const innerCmd = `export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; ${cmd.replace(/'/g, "'\\''")}`;

    return [
        `mkdir -p "${prootTmpDir}"`,
        `&&`,
        // Ensure workspace dir exists on host before proot tries to bind it
        `mkdir -p "${workspaceDir}"`,
        `&&`,
        `export PROOT_TMP_DIR="${prootTmpDir}"`,
        `&&`,
        `export PROOT_LOADER="${prootLoaderBin}"`,
        `&&`,
        `"${prootBin}"`,
        `--rootfs="${rootfsDir}"`,
        `--bind=/dev`,
        `--bind=/proc`,
        `--bind=/sys`,
        `"--bind=${workspaceDir}:/workspace"`,
        `-w "${resolvedCwd}"`,
        `-0`,
        `/bin/sh -c '${innerCmd}'`,
    ].join(" ");
}
