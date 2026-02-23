#pragma once

#include <atomic>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
#include <vterm.h>

namespace pocket {
namespace terminal {

// 封装 libvterm 单元格结构，便于通过 ArrayBuffer (JSI) 零碎拷贝直接传给
// JavaScript
#pragma pack(push, 1)
struct TerminalCell {
  uint32_t ch;    // Unicode CodePoint of the primary character
  uint32_t fg;    // Foreground color ARGB (or RGB)
  uint32_t bg;    // Background color ARGB
  uint32_t flags; // Bit flags (e.g., bit 0: bold, bit 1: underline, etc.)
};
#pragma pack(pop)

class PocketTerminal {
public:
  PocketTerminal(int rows, int cols);
  ~PocketTerminal();

  // 调整终端大小
  void resize(int rows, int cols);

  // 初始化并在沙盒内启动真实 PTY 子进程 (如 /system/bin/sh)
  bool startPty();

  // 停止并清理 PTY 进程与线程
  void stopPty();

  // 输入字节流。如果有 PTY 附加则写入 Pty，否则只在测试模式驱动 VTerm状态机
  size_t writeInput(const char *data, size_t len);

  // 获取当前二维渲染栅格的裸指针，实现零拷贝读取
  // 注意：真实环境中该缓冲的实际读取应由外部完成
  const TerminalCell *getBuffer() const { return m_cellBuffer.data(); }

  // 线程安全的缓冲复制
  void copyBufferOut(TerminalCell *outBuffer, size_t maxBytes);

  // 获取终端尺寸
  int getRows() const { return m_rows; }
  int getCols() const { return m_cols; }

  // 获取光标位置
  int getCursorX() const { return m_cursorX; }
  int getCursorY() const { return m_cursorY; }

private:
  void readerLoop();

  // libvterm 实例引用
  VTerm *m_vterm{nullptr};
  VTermScreen *m_screen{nullptr};

  int m_rows{0};
  int m_cols{0};

  // 光标位置
  int m_cursorX{0};
  int m_cursorY{0};

  // 内部持有的连续内存缓冲，映射终端的每一行每一列
  std::vector<TerminalCell> m_cellBuffer;

  // 线程保护锁，保护从多个线程（JS 主线程写，PTY后台线程读/写）并发访问
  // libvterm
  std::mutex m_vtermMutex;

  // PTY 文件描述符和子进程 ID
  int m_ptyFd{-1};
  pid_t m_pid{-1};

  // 独立读取子线程与运行状态标志
  std::thread m_readerThread;
  std::atomic<bool> m_running{false};

  // libvterm 的屏幕更新回调集合
  static int onDamage(VTermRect rect, void *user);
  static int onMoveCursor(VTermPos pos, VTermPos oldpos, int visible,
                          void *user);
};

} // namespace terminal
} // namespace pocket
