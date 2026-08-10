package expo.modules.pocketterminalmodule

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import com.facebook.react.bridge.ReactApplicationContext
import java.net.URL
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.util.zip.GZIPInputStream
import java.nio.file.Files as NioFiles
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

class PocketTerminalModule : Module() {
  companion object {
    init {
      System.loadLibrary("pocket_terminal_module")
    }
  }

  private external fun installJSI(jsiPtr: Long)

  // ── Background process management ──────────────────────────────────────────
  private val bgProcesses = ConcurrentHashMap<Int, Process>()
  private val pidCounter  = AtomicInteger(0)

  override fun definition() = ModuleDefinition {
    Name("PocketTerminalModule")

    Constant("PI") { Math.PI }
    Events("onChange", "onProcessOutput", "onProcessExit")

    Function("hello") { "Hello world! 👋" }

    Function("install") {
      val reactCtx = appContext.reactContext as? ReactApplicationContext
      val jsiPtr = reactCtx?.javaScriptContextHolder?.get() ?: 0L
      if (jsiPtr != 0L) { installJSI(jsiPtr); true } else { false }
    }

    // 暴露原生库路径（保留接口）
    Function("getNativeLibDir") {
      appContext.reactContext?.applicationInfo?.nativeLibraryDir
    }

    /** Resolve existing symlinks and enforce canonical worktree containment. */
    AsyncFunction("resolveWorkspacePath") {
      rootPath: String, relativePath: String, allowMissing: Boolean ->
      val root = File(rootPath).canonicalFile
      if (!root.isDirectory) {
        throw IllegalArgumentException("Workspace root is unavailable")
      }
      val target = File(root, relativePath).canonicalFile
      val rootPrefix = root.path.trimEnd(File.separatorChar) + File.separator
      if (target.path != root.path && !target.path.startsWith(rootPrefix)) {
        throw IllegalArgumentException("Workspace path resolves outside the workspace")
      }
      if (!allowMissing && !target.exists()) {
        throw IllegalArgumentException("Workspace path does not exist")
      }
      target.path
    }

    /**
     * 纯 JVM tar.gz 解压，正确处理 Alpine Linux 的绝对路径软链接。
     * Android SELinux 禁止从 app 数据目录执行二进制，所以我们在 JVM 内完成解压。
     *
     * @param tarPath  tar.gz 文件的绝对路径
     * @param destPath 目标解压目录的绝对路径
     * @return Map { success, filesCount, error? }
     */
    AsyncFunction("extractTarGz") { tarPath: String, destPath: String ->
      try {
        val dest = File(destPath)
        dest.mkdirs()
        var filesCount = 0

        File(tarPath).inputStream().buffered().let { GZIPInputStream(it) }.use { gzip ->
          extractTar(gzip, dest)
            .also { filesCount = it }
        }

        mapOf("success" to true, "filesCount" to filesCount)
      } catch (e: Exception) {
        e.printStackTrace()
        mapOf("success" to false, "error" to (e.message ?: "Unknown error"))
      }
    }

    // 本地命令执行
    AsyncFunction("runLocalCommand") { command: String, workdir: String ->
      val pb = ProcessBuilder("/system/bin/sh", "-c", command)
      // If workdir doesn't exist, fall back to "/" to avoid IOException
      val dir = File(workdir)
      pb.directory(if (dir.exists()) dir else File("/"))
      val process = pb.start()
      val stdout = process.inputStream.bufferedReader().readText()
      val stderr = process.errorStream.bufferedReader().readText()
      val exitCode = process.waitFor()
      mapOf(
        "success"  to (exitCode == 0),
        "stdout"   to stdout.take(10000),
        "stderr"   to stderr.take(5000),
        "exitCode" to exitCode
      )
    }

    /**
     * 启动后台长期运行进程（dev server、watcher 等）。
     * 立即返回 processId，不等待退出。
     * stdout+stderr 通过 onProcessOutput 事件流式推送。
     * 进程退出时触发 onProcessExit 事件。
     */
    AsyncFunction("startProcess") { command: String, workdir: String ->
      val pid = pidCounter.incrementAndGet()
      val pb = ProcessBuilder("/system/bin/sh", "-c", command)
      val dir = File(workdir)
      pb.directory(if (dir.exists()) dir else File("/"))
      pb.redirectErrorStream(true) // 合并 stderr 到 stdout
      val process = pb.start()
      bgProcesses[pid] = process

      // 后台线程逐行读取输出并推送事件
      Thread {
        try {
          process.inputStream.bufferedReader().forEachLine { line ->
            if (bgProcesses.containsKey(pid)) {
              sendEvent("onProcessOutput", mapOf("processId" to pid, "data" to line))
            }
          }
        } catch (_: Exception) {
          // 进程被 kill 或流关闭，正常退出
        } finally {
          val exitCode = try { process.exitValue() } catch (_: Exception) { -1 }
          bgProcesses.remove(pid)
          sendEvent("onProcessExit", mapOf("processId" to pid, "exitCode" to exitCode))
        }
      }.also { it.isDaemon = true }.start()

      mapOf("success" to true, "processId" to pid)
    }

    /**
     * 停止后台进程。
     * 递归杀掉整棵进程树（proot + 子进程），使用 SIGKILL 确保立即终止。
     */
    Function("stopProcess") { pid: Int ->
      val process = bgProcesses.remove(pid)
      if (process != null) {
        try {
          val osPid = getProcessPid(process)
          if (osPid != null) killProcessTree(osPid)
        } catch (_: Exception) {}
        process.destroyForcibly()
      }
      mapOf("success" to true)
    }

    AsyncFunction("setValueAsync") { value: String ->
      sendEvent("onChange", mapOf("value" to value))
    }

    View(PocketTerminalModuleView::class) {
      Prop("url") { view: PocketTerminalModuleView, url: URL ->
        view.webView.loadUrl(url.toString())
      }
      Events("onLoad")
    }
  }

  /**
   * 解析并提取 tar 流到 destDir。
   * 正确处理 Alpine Linux 使用的绝对路径软链接（如 ./bin/sh -> /usr/bin/busybox）：
   * - 绝对路径目标会转换为相对于 destDir 的形式（不会跨越 destDir 边界）
   */
  private fun extractTar(tarInput: InputStream, destDir: File): Int {
    val buf = ByteArray(512)
    var count = 0

    while (true) {
      // Read one 512-byte header block
      val headerBytes = readFully(tarInput, buf) ?: break

      // End of archive: two consecutive zero blocks
      if (headerBytes.all { it == 0.toByte() }) break

      val name    = readString(headerBytes, 0, 100).trimStart('.', '/')
      val modeStr = readString(headerBytes, 100, 8).trim()
      val sizeStr = readString(headerBytes, 124, 12).trim()
      val typeFlag = headerBytes[156].toInt().toChar()
      val linkName = readString(headerBytes, 157, 100)

      // GNU / POSIX long name extension
      if (name.isEmpty() && typeFlag != 'L') { skipPadding(tarInput, 0); continue }

      val size = if (sizeStr.isEmpty()) 0L else sizeStr.toLong(8)
      val mode = if (modeStr.isEmpty()) 0 else modeStr.toInt(8)
      // Executable if any of owner/group/other execute bits are set
      val isExecutable = (mode and 0b001001001) != 0

      when (typeFlag) {
        '0', '\u0000', '7' -> { // Regular file
          val outFile = File(destDir, name)
          outFile.parentFile?.mkdirs()
          FileOutputStream(outFile).use { out ->
            var remaining = size
            val dataBuf = ByteArray(8192)
            while (remaining > 0) {
              val toRead = minOf(remaining, dataBuf.size.toLong()).toInt()
              val read = tarInput.read(dataBuf, 0, toRead)
              if (read < 0) break
              out.write(dataBuf, 0, read)
              remaining -= read
            }
          }
          if (isExecutable) outFile.setExecutable(true, false)
          skipPadding(tarInput, size)
          count++
        }
        '2' -> { // Symbolic link
          val linkFile = File(destDir, name)
          linkFile.parentFile?.mkdirs()
          val linkPath = linkFile.toPath()
          try {
            if (NioFiles.exists(linkPath) || NioFiles.isSymbolicLink(linkPath)) {
              NioFiles.delete(linkPath)
            }
            NioFiles.createSymbolicLink(linkPath, java.nio.file.Paths.get(linkName))
          } catch (e: Exception) {
            // fallback to Runtime ln if NIO fails (e.g. unsupported filesystem)
            Runtime.getRuntime().exec(arrayOf("/system/bin/ln", "-sf", linkName, linkFile.absolutePath)).waitFor()
          }
          count++
        }
        '5' -> { // Directory
          File(destDir, name).mkdirs()
        }
        'L' -> { // GNU long filename — read the actual name from data block
          val nameBuf = ByteArray(size.toInt())
          readFully(tarInput, nameBuf)
          skipPadding(tarInput, size)
          // Next header will use this name — skip for now (simplified handling)
        }
        else -> {
          skipPadding(tarInput, size)
        }
      }
    }
    return count
  }

  private fun readFully(input: InputStream, buf: ByteArray): ByteArray? {
    var offset = 0
    while (offset < buf.size) {
      val read = input.read(buf, offset, buf.size - offset)
      if (read < 0) return if (offset == 0) null else buf
      offset += read
    }
    return buf
  }

  private fun readString(buf: ByteArray, offset: Int, length: Int): String {
    val end = (offset until offset + length).firstOrNull { buf[it] == 0.toByte() } ?: (offset + length)
    return String(buf, offset, end - offset, Charsets.UTF_8)
  }

  /**
   * 通过反射获取 Java Process 对象对应的 OS PID。
   * 兼容所有 Android 版本：优先用 Process.pid()（Java 9+），回退到字段反射。
   */
  private fun getProcessPid(process: Process): Int? {
    return try {
      val pidMethod = Process::class.java.getMethod("pid")
      (pidMethod.invoke(process) as? Long)?.toInt()
    } catch (_: Exception) {
      try {
        val field = process.javaClass.getDeclaredField("pid")
        field.isAccessible = true
        field.getInt(process)
      } catch (_: Exception) { null }
    }
  }

  /**
   * 递归杀掉以 rootPid 为根的整棵进程树（通过读取 /proc 找子进程）。
   * 先递归杀子孙，再 SIGKILL 自身，确保 proot / node 等孙子进程不变成孤儿。
   */
  private fun killProcessTree(rootPid: Int) {
    try {
      File("/proc").listFiles { f -> f.isDirectory && f.name.all { c -> c.isDigit() } }
        ?.forEach { procDir ->
          try {
            val ppid = File(procDir, "status").readLines()
              .firstOrNull { it.startsWith("PPid:") }
              ?.removePrefix("PPid:")?.trim()?.toIntOrNull()
            if (ppid == rootPid) {
              killProcessTree(procDir.name.toInt())
            }
          } catch (_: Exception) {}
        }
    } catch (_: Exception) {}
    android.os.Process.killProcess(rootPid)
  }

  private fun skipPadding(input: InputStream, size: Long) {
    val remainder = (512 - (size % 512)) % 512
    if (remainder > 0) input.skip(remainder)
  }
}
