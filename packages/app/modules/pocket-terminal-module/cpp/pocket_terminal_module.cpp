#include "pocket_terminal.h"
#include "pocket_terminal_host_object.h"
#include <jsi/jsi.h>

#include <jni.h>

// JNI 动态加载与 JSI 沙盒植入入口
extern "C" JNIEXPORT void JNICALL
Java_expo_modules_pocketterminalmodule_PocketTerminalModule_installJSI(
    JNIEnv *env, jobject thiz, jlong jsiPtr) {
  if (jsiPtr == 0)
    return;
  auto *rt = reinterpret_cast<facebook::jsi::Runtime *>(jsiPtr);
  using namespace pocket::terminal;
  namespace jsi = facebook::jsi;

  // 向 JS 侧全局挂载一个构造函数 `createTerminalCore`
  auto createFunc = [=](jsi::Runtime &runtime, const jsi::Value &thisValue,
                        const jsi::Value *args, size_t count) -> jsi::Value {
    int rows = 24;
    int cols = 80;

    if (count >= 2 && args[0].isNumber() && args[1].isNumber()) {
      rows = args[0].asNumber();
      cols = args[1].asNumber();
    }

    // 分配 HostObject
    auto hostObj = std::make_shared<PocketTerminalHostObject>(rows, cols);
    return jsi::Object::createFromHostObject(runtime, hostObj);
  };

  auto propName = jsi::PropNameID::forAscii(*rt, "createTerminalCore");
  auto jsiFunc =
      jsi::Function::createFromHostFunction(*rt, propName, 2, createFunc);

  // 挂载到 JavaScript 的 global 对象上，以便可以通过 global.createTerminalCore
  // 访问
  rt->global().setProperty(*rt, "createTerminalCore", jsiFunc);
}
