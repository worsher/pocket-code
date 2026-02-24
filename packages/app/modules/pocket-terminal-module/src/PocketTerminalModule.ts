import { requireNativeModule } from 'expo-modules-core';

/**
 * C++ 侧底层 JSI 挂载的对象接口定义
 * 这由 pocket_terminal_host_objectcpp 中的 get拦截器 决定
 */
export interface NativeTerminalCore {
  /** 向 C++ 底层 libvterm 沙箱推入数据流 */
  write(data: string): void;
  getRows(): number;
  getCols(): number;
  getBuffer(): ArrayBuffer;
  getCursorX(): number;
  getCursorY(): number;
  startPty(): boolean;
  stopPty(): void;
  resize(rows: number, cols: number): void;
  // 获取刚刚被挤出屏幕的历史行数组
  pullScrollback(): { buffer: ArrayBuffer; rowLengths: number[] } | null;
}

// 声明全局挂载构造函数 (由 pocket_terminal_module.cpp 注入)
declare const global: {
  createTerminalCore?: (rows: number, cols: number) => NativeTerminalCore;
} & typeof globalThis;

export class PocketTerminal {
  private _core: NativeTerminalCore | null = null;

  constructor(public readonly rows: number = 24, public readonly cols: number = 80) {
    if (typeof global.createTerminalCore !== 'function') {
      try {
        const NativeModule = requireNativeModule('PocketTerminalModule');
        const installed = NativeModule.install();
        if (!installed) {
          console.warn(
            "PocketTerminalModule's JSI methods failed to install. Ensure the module is properly linked."
          );
        }
      } catch (e) {
        console.warn("Error installing PocketTerminalModule JSI: ", e);
      }
    }

    if (typeof global.createTerminalCore === 'function') {
      this._core = global.createTerminalCore(rows, cols);
    } else {
      console.warn("PocketTerminal JSI bind failed: global.createTerminalCore remains undefined.");
    }
  }

  public write(data: string) {
    this._core?.write(data);
  }

  public getRows() {
    return this._core?.getRows() ?? this.rows;
  }

  public getCols() {
    return this._core?.getCols() ?? this.cols;
  }

  public getBuffer() {
    // Falls back to an empty ArrayBuffer if the core isn't injected yet.
    return this._core?.getBuffer() ?? new ArrayBuffer(0);
  }

  public getCursorX() {
    return this._core?.getCursorX() ?? 0;
  }

  public getCursorY() {
    return this._core?.getCursorY() ?? 0;
  }

  public startPty() {
    return this._core?.startPty() ?? false;
  }

  public stopPty() {
    this._core?.stopPty();
  }

  public resize(rows: number, cols: number) {
    (this._core as any)?.resize?.(rows, cols);
  }

  public pullScrollback() {
    return this._core?.pullScrollback() ?? null;
  }
}

/** 无交互式本地命令执行，供 AI 工具调用 */
export async function runLocalCommand(
  command: string,
  workdir: string = '.'
): Promise<{ success: boolean; stdout: string; stderr: string; exitCode: number }> {
  const module = requireNativeModule('PocketTerminalModule');
  return module.runLocalCommand(command, workdir);
}

/** 获取原生私有 lib 路径 */
export function getNativeLibDir(): string | null {
  const module = requireNativeModule('PocketTerminalModule');
  return module.getNativeLibDir ? module.getNativeLibDir() : null;
}

/**
 * 纯 JVM tar.gz 解压，正确处理 Alpine Linux 的绝对路径软链接。
 * 在 JVM 上运行，完全绕过 Android SELinux 执行限制。
 */
export async function extractTarGz(
  tarPath: string,
  destPath: string
): Promise<{ success: boolean; filesCount?: number; error?: string }> {
  const module = requireNativeModule('PocketTerminalModule');
  return module.extractTarGz(tarPath, destPath);
}
