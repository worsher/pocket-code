#include "pocket_terminal.h"
#include <algorithm>
#include <cstring>
#include <fcntl.h>
#include <pty.h>
#include <stdexcept>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <unistd.h>

namespace pocket {
namespace terminal {

static VTermColor get_default_fg() {
  VTermColor c;
  vterm_color_rgb(&c, 255, 255, 255);
  return c;
}
static VTermColor get_default_bg() {
  VTermColor c;
  vterm_color_rgb(&c, 0, 0, 0);
  return c;
}

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

  VTermColor fg = get_default_fg();
  VTermColor bg = get_default_bg();
  vterm_screen_set_default_colors(m_screen, &fg, &bg);

  static VTermScreenCallbacks cb = {};
  cb.damage = onDamage;
  cb.movecursor = onMoveCursor;
  cb.sb_pushline = onSbPushLine;

  // 注册回调，并将 this 指针传递供 C 回调使用
  vterm_screen_set_callbacks(m_screen, &cb, this);

  vterm_screen_reset(m_screen, 1);
}

PocketTerminal::~PocketTerminal() {
  stopPty();
  if (m_vterm) {
    vterm_free(m_vterm);
  }
}

void PocketTerminal::resize(int rows, int cols) {
  if (rows == m_rows && cols == m_cols)
    return;

  m_rows = rows;
  m_cols = cols;

  {
    std::lock_guard<std::mutex> lock(m_vtermMutex);
    m_cellBuffer.resize(rows * cols);
    vterm_set_size(m_vterm, rows, cols);
  }

  // 通知子进程 PTY 尺寸改变
  if (m_ptyFd >= 0) {
    struct winsize ws;
    ws.ws_row = rows;
    ws.ws_col = cols;
    ws.ws_xpixel = 0;
    ws.ws_ypixel = 0;
    ioctl(m_ptyFd, TIOCSWINSZ, &ws);
  }
}

size_t PocketTerminal::writeInput(const char *data, size_t len) {
  // 如果 PTY 已连接且正在运行，则直接将输入推给真实的 Linux 子进程 PTY 管道
  if (m_ptyFd >= 0 && m_running) {
    return write(m_ptyFd, data, len);
  }

  // 否则 (比如用于只读或者脱机截屏状态) 直接推给 vterm 状态机
  if (!m_vterm || len == 0)
    return 0;

  std::lock_guard<std::mutex> lock(m_vtermMutex);
  return vterm_input_write(m_vterm, data, len);
}

void PocketTerminal::copyBufferOut(TerminalCell *outBuffer, size_t maxBytes) {
  std::lock_guard<std::mutex> lock(m_vtermMutex);
  size_t bytesToCopy =
      std::min(maxBytes, m_cellBuffer.size() * sizeof(TerminalCell));
  std::memcpy(outBuffer, m_cellBuffer.data(), bytesToCopy);
}

bool PocketTerminal::startPty() {
  if (m_running)
    return false;

  m_pid = forkpty(&m_ptyFd, nullptr, nullptr, nullptr);
  if (m_pid < 0) {
    return false; // Error Forking
  }

  if (m_pid == 0) {
    // Child process: execute shell
    setenv("TERM", "xterm-256color", 1);
    const char *shell = "/system/bin/sh";
    execl(shell, "-", nullptr);
    exit(1);
  }

  // Parent process
  m_running = true;
  m_readerThread = std::thread(&PocketTerminal::readerLoop, this);

  // 初始化设置窗口大小
  struct winsize ws;
  ws.ws_row = m_rows;
  ws.ws_col = m_cols;
  ws.ws_xpixel = 0;
  ws.ws_ypixel = 0;
  ioctl(m_ptyFd, TIOCSWINSZ, &ws);

  return true;
}

void PocketTerminal::stopPty() {
  m_running = false;
  if (m_ptyFd >= 0) {
    close(m_ptyFd);
    m_ptyFd = -1;
  }
  if (m_pid > 0) {
    kill(m_pid, SIGKILL);
    waitpid(m_pid, nullptr, 0);
    m_pid = -1;
  }
  if (m_readerThread.joinable()) {
    m_readerThread.join();
  }
}

void PocketTerminal::readerLoop() {
  char buf[4096];
  while (m_running) {
    int bytesRead = read(m_ptyFd, buf, sizeof(buf));
    if (bytesRead > 0) {
      std::lock_guard<std::mutex> lock(m_vtermMutex);
      vterm_input_write(m_vterm, buf, bytesRead);
    } else if (bytesRead <= 0) {
      // Error or EOF (Shell closed)
      break;
    }
  }
  m_running = false;
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

      out.ch = vcell.chars[0];

      // 将可能存在的 Palette(Index) 色彩空间强制转换为 RGB 真彩色方便前端消费
      vterm_screen_convert_color_to_rgb(self->m_screen, &vcell.fg);
      vterm_screen_convert_color_to_rgb(self->m_screen, &vcell.bg);

      // ARGB (0xAARRGGBB) 方便 JS 端 Uint32Array 直接解析
      out.fg = (0xFF << 24) | (vcell.fg.rgb.red << 16) |
               (vcell.fg.rgb.green << 8) | vcell.fg.rgb.blue;
      out.bg = (0xFF << 24) | (vcell.bg.rgb.red << 16) |
               (vcell.bg.rgb.green << 8) | vcell.bg.rgb.blue;

      // 组装标志位: bit 0(bold), 1(underline), 2(italic), 3(blink), 4(reverse),
      // 5(strike) bit 8-15 存放宽度 (width)
      uint32_t flags = 0;
      if (vcell.attrs.bold)
        flags |= (1 << 0);
      if (vcell.attrs.underline)
        flags |= (1 << 1);
      if (vcell.attrs.italic)
        flags |= (1 << 2);
      if (vcell.attrs.blink)
        flags |= (1 << 3);
      if (vcell.attrs.reverse)
        flags |= (1 << 4);
      if (vcell.attrs.strike)
        flags |= (1 << 5);

      flags |= ((vcell.width & 0xFF) << 8);
      out.flags = flags;
    }
  }
  return 1;
}

int PocketTerminal::onMoveCursor(VTermPos pos, VTermPos oldpos, int visible,
                                 void *user) {
  // 处理光标移动，记录当前光标位置供上层渲染
  auto self = static_cast<PocketTerminal *>(user);
  self->m_cursorX = pos.col;
  self->m_cursorY = pos.row;
  return 1;
}

void PocketTerminal::pullScrollback(std::vector<TerminalCell> &outCells,
                                    std::vector<int> &outRowLengths) {
  std::lock_guard<std::mutex> lock(m_vtermMutex);
  outCells.clear();
  outRowLengths.clear();

  for (auto &row : m_scrollbackBuffer) {
    outRowLengths.push_back(row.size());
    outCells.insert(outCells.end(), row.begin(), row.end());
  }
  m_scrollbackBuffer.clear();
}

int PocketTerminal::onSbPushLine(int cols, const VTermScreenCell *cells,
                                 void *user) {
  auto self = static_cast<PocketTerminal *>(user);

  std::vector<TerminalCell> rowData;
  rowData.reserve(cols);

  for (int col = 0; col < cols; ++col) {
    TerminalCell out;
    const VTermScreenCell &vcell = cells[col];
    out.ch = vcell.chars[0];

    VTermColor fg = vcell.fg;
    VTermColor bg = vcell.bg;
    vterm_screen_convert_color_to_rgb(self->m_screen, &fg);
    vterm_screen_convert_color_to_rgb(self->m_screen, &bg);

    out.fg =
        (0xFF << 24) | (fg.rgb.red << 16) | (fg.rgb.green << 8) | fg.rgb.blue;
    out.bg =
        (0xFF << 24) | (bg.rgb.red << 16) | (bg.rgb.green << 8) | bg.rgb.blue;

    uint32_t flags = 0;
    if (vcell.attrs.bold)
      flags |= (1 << 0);
    if (vcell.attrs.underline)
      flags |= (1 << 1);
    if (vcell.attrs.italic)
      flags |= (1 << 2);
    if (vcell.attrs.blink)
      flags |= (1 << 3);
    if (vcell.attrs.reverse)
      flags |= (1 << 4);
    if (vcell.attrs.strike)
      flags |= (1 << 5);
    flags |= ((vcell.width & 0xFF) << 8);
    out.flags = flags;

    rowData.push_back(out);
  }

  // 此回调一般由 vterm_input_write 等函数同步触发，此时已被 m_vtermMutex 保护，
  // 所以操作 std::deque 是并发安全的（pullScrollback 此时无法被抢占并调用）。
  if (self->m_scrollbackBuffer.size() >= self->m_maxScrollback) {
    self->m_scrollbackBuffer.pop_front();
  }
  self->m_scrollbackBuffer.push_back(std::move(rowData));

  return 1;
}

} // namespace terminal
} // namespace pocket
