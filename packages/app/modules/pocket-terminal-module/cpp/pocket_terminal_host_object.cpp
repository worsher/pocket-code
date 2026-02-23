#include "pocket_terminal_host_object.h"
#include <iostream>

namespace pocket {
namespace terminal {

PocketTerminalHostObject::PocketTerminalHostObject(int rows, int cols) {
  m_terminal = std::make_unique<PocketTerminal>(rows, cols);
}

PocketTerminalHostObject::~PocketTerminalHostObject() {
  // 释放到底座
}

jsi::Value PocketTerminalHostObject::get(jsi::Runtime &rt,
                                         const jsi::PropNameID &name) {
  auto propName = name.utf8(rt);

  if (propName == "write") {
    auto func = [this](jsi::Runtime &rt, const jsi::Value &thisValue,
                       const jsi::Value *args, size_t count) -> jsi::Value {
      if (count > 0 && args[0].isString()) {
        std::string text = args[0].asString(rt).utf8(rt);
        this->writeOutput(text);
      }
      return jsi::Value::undefined();
    };
    return jsi::Function::createFromHostFunction(rt, name, 1, func);
  } else if (propName == "getRows") {
    auto func = [this](jsi::Runtime &rt, const jsi::Value &thisValue,
                       const jsi::Value *args, size_t count) -> jsi::Value {
      return jsi::Value(m_terminal->getRows());
    };
    return jsi::Function::createFromHostFunction(rt, name, 0, func);
  } else if (propName == "getCols") {
    auto func = [this](jsi::Runtime &rt, const jsi::Value &thisValue,
                       const jsi::Value *args, size_t count) -> jsi::Value {
      return jsi::Value(m_terminal->getCols());
    };
    return jsi::Function::createFromHostFunction(rt, name, 0, func);
  } else if (propName == "getCursorX") {
    auto func = [this](jsi::Runtime &rt, const jsi::Value &thisValue,
                       const jsi::Value *args, size_t count) -> jsi::Value {
      return jsi::Value(m_terminal->getCursorX());
    };
    return jsi::Function::createFromHostFunction(rt, name, 0, func);
  } else if (propName == "getCursorY") {
    auto func = [this](jsi::Runtime &rt, const jsi::Value &thisValue,
                       const jsi::Value *args, size_t count) -> jsi::Value {
      return jsi::Value(m_terminal->getCursorY());
    };
    return jsi::Function::createFromHostFunction(rt, name, 0, func);
  } else if (propName == "getScreenText") {
    auto func = [this](jsi::Runtime &rt, const jsi::Value &thisValue,
                       const jsi::Value *args, size_t count) -> jsi::Value {
      auto buffer = m_terminal->getBuffer();
      int rows = m_terminal->getRows();
      int cols = m_terminal->getCols();

      std::string screenStr;
      // 预分配内存，每行以换行符结束
      screenStr.reserve(rows * (cols + 1));

      for (int r = 0; r < rows; ++r) {
        for (int c = 0; c < cols; ++c) {
          const auto &cell = buffer[r * cols + c];
          if (cell.chars[0] == 0) {
            screenStr += ' ';
          } else {
            // 目前只处理单字节 ASCII/UTF-8 简单呈现（后续可完善多字节支持）
            // VTerm 会将 unicode 编在 chars 数组中
            char chStr[5] = {0};
            int len = 0;
            for (int i = 0; cell.chars[i] && i < VTERM_MAX_CHARS_PER_CELL;
                 i++) {
              uint32_t c32 = cell.chars[i];
              if (c32 < 0x80) {
                chStr[len++] = (char)c32;
              } else if (c32 < 0x800) {
                chStr[len++] = 0xC0 | (c32 >> 6);
                chStr[len++] = 0x80 | (c32 & 0x3F);
              } else if (c32 < 0x10000) {
                chStr[len++] = 0xE0 | (c32 >> 12);
                chStr[len++] = 0x80 | ((c32 >> 6) & 0x3F);
                chStr[len++] = 0x80 | (c32 & 0x3F);
              } else {
                chStr[len++] = 0xF0 | (c32 >> 18);
                chStr[len++] = 0x80 | ((c32 >> 12) & 0x3F);
                chStr[len++] = 0x80 | ((c32 >> 6) & 0x3F);
                chStr[len++] = 0x80 | (c32 & 0x3F);
              }
            }
            if (len == 0) {
              screenStr += ' ';
            } else {
              screenStr += chStr;
            }
          }
        }
        screenStr += '\n';
      }
      return jsi::String::createFromUtf8(rt, screenStr);
    };
    return jsi::Function::createFromHostFunction(rt, name, 0, func);
  }

  return jsi::Value::undefined();
}

void PocketTerminalHostObject::set(jsi::Runtime &rt,
                                   const jsi::PropNameID &name,
                                   const jsi::Value &value) {
  // 暂不处理向属性赋值
}

void PocketTerminalHostObject::writeOutput(const std::string &text) {
  m_terminal->writeInput(text.c_str(), text.length());
}

void *PocketTerminalHostObject::getRawBufferAddress() const {
  return const_cast<TerminalCell *>(m_terminal->getBuffer());
}

} // namespace terminal
} // namespace pocket
