#pragma once

#include "pocket_terminal.h"
#include <jsi/jsi.h>
#include <memory>
#include <string>

namespace pocket {
namespace terminal {

namespace jsi = facebook::jsi;

/**
 * 暴露给 JavaScript 环境的同步底层桥接对象
 */
class PocketTerminalHostObject : public jsi::HostObject {
public:
  PocketTerminalHostObject(int rows, int cols);
  ~PocketTerminalHostObject();

  // 当 JSI 尝试访问 JS 侧属 (如 myTerm.rows) 时触发
  jsi::Value get(jsi::Runtime &rt, const jsi::PropNameID &name) override;

  // 当 JSI 尝试写入 JS 侧属性时触发
  void set(jsi::Runtime &rt, const jsi::PropNameID &name,
           const jsi::Value &value) override;

  // 暴露核心状态机操作
  void writeOutput(const std::string &text);

  // (远期扩展结构) 获取 DirectBuffer 的映射地址等
  void *getRawBufferAddress() const;

private:
  std::unique_ptr<PocketTerminal> m_terminal;
};

} // namespace terminal
} // namespace pocket
