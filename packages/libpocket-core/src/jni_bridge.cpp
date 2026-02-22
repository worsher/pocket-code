#include "pocket_terminal.h"
#include <jni.h>

using namespace pocket::terminal;

extern "C" {

JNIEXPORT jlong JNICALL Java_com_pocketcode_terminal_TerminalCore_createVTerm(
    JNIEnv *env, jobject thiz, jint rows, jint cols) {
  auto *term = new PocketTerminal(rows, cols);
  return reinterpret_cast<jlong>(term);
}

JNIEXPORT void JNICALL Java_com_pocketcode_terminal_TerminalCore_destroyVTerm(
    JNIEnv *env, jobject thiz, jlong ptr) {
  auto *term = reinterpret_cast<PocketTerminal *>(ptr);
  delete term;
}

JNIEXPORT jobject JNICALL
Java_com_pocketcode_terminal_TerminalCore_getDirectBuffer(JNIEnv *env,
                                                          jobject thiz,
                                                          jlong ptr) {
  auto *term = reinterpret_cast<PocketTerminal *>(ptr);
  if (!term)
    return nullptr;

  const void *addr = term->getBuffer();
  // VTermCell[] 大小：总行数 * 列数 * sizeof(TerminalCell)
  // 根据 pocket_terminal.h 推算大小大概是每格 32 ~ 64 bytes 左右
  jlong capacity = term->getRows() * term->getCols() * sizeof(TerminalCell);

  // 返回共享的零拷贝 Buffer 到 Java 层
  return env->NewDirectByteBuffer(const_cast<void *>(addr), capacity);
}

JNIEXPORT void JNICALL Java_com_pocketcode_terminal_TerminalCore_writeOutput(
    JNIEnv *env, jobject thiz, jlong ptr, jbyteArray data, jint len) {
  auto *term = reinterpret_cast<PocketTerminal *>(ptr);
  if (!term)
    return;

  jbyte *buffer = env->GetByteArrayElements(data, nullptr);
  term->writeInput(reinterpret_cast<const char *>(buffer), len);
  env->ReleaseByteArrayElements(data, buffer, JNI_ABORT);
}

} // extern "C"
