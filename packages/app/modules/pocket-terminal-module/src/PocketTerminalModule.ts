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
  getScreenText(): string;
  getCursorX(): number;
  getCursorY(): number;
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

  public getScreenText() {
    return this._core?.getScreenText() ?? "";
  }

  public getCursorX() {
    return this._core?.getCursorX() ?? 0;
  }

  public getCursorY() {
    return this._core?.getCursorY() ?? 0;
  }
}
