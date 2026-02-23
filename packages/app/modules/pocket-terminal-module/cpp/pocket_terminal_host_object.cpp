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
  } else if (propName == "getBuffer") {
    auto func = [this](jsi::Runtime &rt, const jsi::Value &thisValue,
                       const jsi::Value *args, size_t count) -> jsi::Value {
      size_t rows = m_terminal->getRows();
      size_t cols = m_terminal->getCols();
      size_t byteLength = rows * cols * sizeof(TerminalCell);

      // Create a JS ArrayBuffer
      jsi::Function arrayBufferCtor =
          rt.global().getPropertyAsFunction(rt, "ArrayBuffer");
      jsi::Object arrayBufferObj =
          arrayBufferCtor.callAsConstructor(rt, static_cast<double>(byteLength))
              .getObject(rt);
      jsi::ArrayBuffer arrayBuffer = arrayBufferObj.getArrayBuffer(rt);

      // Copy cells data to JS reachable ArrayBuffer memory using thread-safe
      // method
      m_terminal->copyBufferOut(
          reinterpret_cast<TerminalCell *>(arrayBuffer.data(rt)), byteLength);

      return arrayBufferObj;
    };
    return jsi::Function::createFromHostFunction(rt, name, 0, func);
  } else if (propName == "startPty") {
    auto func = [this](jsi::Runtime &rt, const jsi::Value &thisValue,
                       const jsi::Value *args, size_t count) -> jsi::Value {
      bool success = m_terminal->startPty();
      return jsi::Value(success);
    };
    return jsi::Function::createFromHostFunction(rt, name, 0, func);
  } else if (propName == "stopPty") {
    auto func = [this](jsi::Runtime &rt, const jsi::Value &thisValue,
                       const jsi::Value *args, size_t count) -> jsi::Value {
      m_terminal->stopPty();
      return jsi::Value::undefined();
    };
    return jsi::Function::createFromHostFunction(rt, name, 0, func);
  } else if (propName == "pullScrollback") {
    auto func = [this](jsi::Runtime &rt, const jsi::Value &thisValue,
                       const jsi::Value *args, size_t count) -> jsi::Value {
      std::vector<TerminalCell> cells;
      std::vector<int> rowLengths;
      m_terminal->pullScrollback(cells, rowLengths);

      if (cells.empty()) {
        return jsi::Value::null();
      }

      // Create ArrayBuffer for the cell data
      size_t byteLength = cells.size() * sizeof(TerminalCell);
      jsi::Function arrayBufferCtor =
          rt.global().getPropertyAsFunction(rt, "ArrayBuffer");
      jsi::Object arrayBufferObj =
          arrayBufferCtor
              .callAsConstructor(rt,
                                 jsi::Value(static_cast<double>(byteLength)))
              .getObject(rt);
      jsi::ArrayBuffer arrayBuffer = arrayBufferObj.getArrayBuffer(rt);

      // Copy contiguous memory to JS ArrayBuffer
      std::memcpy(arrayBuffer.data(rt), cells.data(), byteLength);

      // Create Javascript Array for row lengths
      jsi::Array jsRowLengths(rt, rowLengths.size());
      for (size_t i = 0; i < rowLengths.size(); ++i) {
        jsRowLengths.setValueAtIndex(rt, i, static_cast<double>(rowLengths[i]));
      }

      // Return composite object: { buffer: ArrayBuffer, rowLengths: [int] }
      jsi::Object result(rt);
      result.setProperty(rt, "buffer", arrayBufferObj);
      result.setProperty(rt, "rowLengths", jsRowLengths);

      return result;
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
