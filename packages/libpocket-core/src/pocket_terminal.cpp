#include "pocket_terminal.h"
#include <cstring>
#include <stdexcept>

namespace pocket {
namespace terminal {

static VTermColor default_fg = {255, 255, 255, 255}; // White
static VTermColor default_bg = {0, 0, 0, 255};       // Black

PocketTerminal::PocketTerminal(int rows, int cols)
    : m_rows(rows), m_cols(cols) {
  if (rows <= 0 || cols <= 0) {
    throw std::invalid_argument("Rows and cols must be strictly positive");
  }

  m_cellBuffer.resize(rows * cols);

  // 初始化 libvterm
  m_vterm = vterm_new(rows, cols);
  if (!m_vterm)
    throw std::runtime_error("Failed to init vterm");

  // 强制 UTF-8 解析
  vterm_set_utf8(m_vterm, 1);

  m_screen = vterm_obtain_screen(m_vterm);
  vterm_screen_enable_altscreen(m_screen, 1);

  vterm_screen_set_default_colors(m_screen, &default_fg, &default_bg);

  VTermScreenCallbacks cb = {};
  cb.damage = onDamage;
  cb.movecursor = onMoveCursor;

  // 注册回调，并将 this 指针传递供 C 回调使用
  vterm_screen_set_callbacks(m_screen, &cb, this);

  vterm_screen_reset(m_screen, 1);
}

PocketTerminal::~PocketTerminal() {
  if (m_vterm) {
    vterm_free(m_vterm);
  }
}

void PocketTerminal::resize(int rows, int cols) {
  if (rows == m_rows && cols == m_cols)
    return;
  m_rows = rows;
  m_cols = cols;
  m_cellBuffer.resize(rows * cols);
  vterm_set_size(m_vterm, rows, cols);
}

size_t PocketTerminal::writeInput(const char *data, size_t len) {
  if (!m_vterm || len == 0)
    return 0;
  // 将数据推入状态机，让其解析光标与字符位置
  return vterm_input_write(m_vterm, data, len);
}

const TerminalCell *PocketTerminal::getBuffer() const {
  return m_cellBuffer.data();
}

// ============== C Callbacks ==============

int PocketTerminal::onDamage(VTermRect rect, void *user) {
  auto self = static_cast<PocketTerminal *>(user);
  if (!self->m_screen)
    return 0;

  // 当终端有任何字符活动（比如接到 printf 输出），触发此回调
  // 更新指定矩形范围内的 Cell
  for (int row = rect.start_row; row < rect.end_row; ++row) {
    for (int col = rect.start_col; col < rect.end_col; ++col) {

      VTermPos pos = {row, col};
      VTermScreenCell vcell;
      // 从 libvterm 读取真正的格式化栅格
      vterm_screen_get_cell(self->m_screen, pos, &vcell);

      // 转换为我们封装供 JNI 使用的 C++ 结构体
      size_t idx = row * self->m_cols + col;
      auto &out = self->m_cellBuffer[idx];

      out.width = vcell.width;
      std::memcpy(out.chars, vcell.chars, sizeof(out.chars));

      // 复制颜色与排版属性
      out.fg = {vcell.fg.red, vcell.fg.green, vcell.fg.blue, 255};
      out.bg = {vcell.bg.red, vcell.bg.green, vcell.bg.blue, 255};

      out.bold = vcell.attrs.bold;
      out.underline = vcell.attrs.underline;
      out.italic = vcell.attrs.italic;
      out.blink = vcell.attrs.blink;
      out.reverse = vcell.attrs.reverse;
      out.strike = vcell.attrs.strike;
    }
  }
  return 1;
}

int PocketTerminal::onMoveCursor(VTermPos pos, VTermPos oldpos, int visible,
                                 void *user) {
  // 处理光标移动，由于是无头终端，光标坐标可额外存放供上层专门渲染光标块
  return 1;
}

} // namespace terminal
} // namespace pocket
