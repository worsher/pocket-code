#pragma once

#include <memory>
#include <string>
#include <vector>
#include <vterm.h>

namespace pocket {
namespace terminal {

// 封装 libvterm 单元格结构，便于上层语言 (Java/Swift) 读取
struct TerminalCell {
  uint32_t chars[VTERM_MAX_CHARS_PER_CELL];
  int width;

  // 颜色封装 (ARGB)
  struct {
    uint8_t r, g, b, a;
  } fg, bg;

  // 文本属性
  bool bold;
  bool underline;
  bool italic;
  bool blink;
  bool reverse;
  bool strike;
};

class PocketTerminal {
public:
  PocketTerminal(int rows, int cols);
  ~PocketTerminal();

  // 调整终端大小
  void resize(int rows, int cols);

  // 输入字节流，驱动状态机更新
  size_t writeInput(const char *data, size_t len);

  // 获取当前二维渲染栅格的裸指针，实现零拷贝读取
  const TerminalCell *getBuffer() const;

  // 获取终端尺寸
  int getRows() const { return m_rows; }
  int getCols() const { return m_cols; }

  // 获取光标位置
  int getCursorX() const { return m_cursorX; }
  int getCursorY() const { return m_cursorY; }

private:
  // libvterm 实例引用
  VTerm *m_vterm{nullptr};
  VTermScreen *m_screen{nullptr};

  int m_rows{0};
  int m_cols{0};

  // 光标位置
  int m_cursorX{0};
  int m_cursorY{0};

  // 内部持有的连续内存缓冲，映射终端的每一行每一列
  // 大小为 m_rows * m_cols
  std::vector<TerminalCell> m_cellBuffer;

  // libvterm 的屏幕更新回调集合
  static int onDamage(VTermRect rect, void *user);
  static int onMoveCursor(VTermPos pos, VTermPos oldpos, int visible,
                          void *user);
};

} // namespace terminal
} // namespace pocket
