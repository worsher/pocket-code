/**
 * expo-file-system/legacy → isomorphic-git fs.promises adapter
 *
 * isomorphic-git requires a Node.js-compatible fs object with a `promises` property.
 * This adapter bridges expo-file-system's legacy API to that interface.
 *
 * Key constraints:
 * - expo-file-system uses `file://` URIs; isomorphic-git uses POSIX paths
 * - Binary data is handled via base64 encoding/decoding
 * - Symlinks are not supported (throws ENOENT)
 * - File permissions always return 0o644 (dirs 0o755)
 */

import * as FileSystem from "expo-file-system/legacy";

// ── Helpers ────────────────────────────────────────────

function makeError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ── Stat result ────────────────────────────────────────

interface StatLike {
  type: "file" | "dir";
  mode: number;
  size: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  uid: 1;
  gid: 1;
  dev: 1;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

function makeStat(info: {
  exists: true;
  size: number;
  isDirectory: boolean;
  modificationTime: number;
}): StatLike {
  const isDir = info.isDirectory;
  return {
    type: isDir ? "dir" : "file",
    mode: isDir ? 0o755 : 0o644,
    size: info.size,
    ino: 0,
    mtimeMs: info.modificationTime * 1000,
    ctimeMs: info.modificationTime * 1000,
    uid: 1,
    gid: 1,
    dev: 1,
    isFile: () => !isDir,
    isDirectory: () => isDir,
    isSymbolicLink: () => false,
  };
}

// ── Adapter factory ────────────────────────────────────

/**
 * Create an fs adapter rooted at `baseDir`.
 * `baseDir` should be a `file://` URI (e.g. FileSystem.documentDirectory + "workspace/").
 * isomorphic-git will pass absolute POSIX paths starting with "/".
 */
export function createFsAdapter(baseDir: string) {
  // Ensure baseDir ends with /
  const root = baseDir.endsWith("/") ? baseDir : baseDir + "/";

  /** Convert isomorphic-git's absolute path to file:// URI */
  function toUri(posixPath: string): string {
    // isomorphic-git passes paths like "/repo/.git/config"
    // We strip the leading "/" and prepend the root URI
    const relative = posixPath.startsWith("/")
      ? posixPath.slice(1)
      : posixPath;
    return root + relative;
  }

  return {
    promises: {
      async readFile(
        filepath: string,
        opts?: { encoding?: "utf8" } | string
      ): Promise<Uint8Array | string> {
        const uri = toUri(filepath);
        const encoding =
          typeof opts === "string" ? opts : opts?.encoding;

        if (encoding === "utf8") {
          return await FileSystem.readAsStringAsync(uri, {
            encoding: FileSystem.EncodingType.UTF8,
          });
        }

        // Binary read: return Uint8Array
        const base64 = await FileSystem.readAsStringAsync(uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        return base64ToUint8Array(base64);
      },

      async writeFile(
        filepath: string,
        data: Uint8Array | string,
        opts?: { encoding?: "utf8" } | string
      ): Promise<void> {
        const uri = toUri(filepath);
        const encoding =
          typeof opts === "string" ? opts : opts?.encoding;

        if (typeof data === "string") {
          await FileSystem.writeAsStringAsync(uri, data, {
            encoding: FileSystem.EncodingType.UTF8,
          });
        } else {
          // Binary write: Uint8Array → base64
          const base64 = uint8ArrayToBase64(data);
          await FileSystem.writeAsStringAsync(uri, base64, {
            encoding: FileSystem.EncodingType.Base64,
          });
        }
      },

      async mkdir(
        filepath: string,
        _opts?: { recursive?: boolean }
      ): Promise<void> {
        const uri = toUri(filepath);
        try {
          await FileSystem.makeDirectoryAsync(uri, {
            intermediates: true,
          });
        } catch {
          // Ignore if already exists
          const info = await FileSystem.getInfoAsync(uri);
          if (!info.exists) throw makeError("EACCES", `Cannot create directory: ${filepath}`);
        }
      },

      async rmdir(filepath: string): Promise<void> {
        const uri = toUri(filepath);
        await FileSystem.deleteAsync(uri, { idempotent: true });
      },

      async unlink(filepath: string): Promise<void> {
        const uri = toUri(filepath);
        await FileSystem.deleteAsync(uri, { idempotent: false });
      },

      async stat(filepath: string): Promise<StatLike> {
        const uri = toUri(filepath);
        const info = await FileSystem.getInfoAsync(uri);
        if (!info.exists) {
          throw makeError("ENOENT", `No such file or directory: ${filepath}`);
        }
        return makeStat(info);
      },

      async lstat(filepath: string): Promise<StatLike> {
        // No symlink support — lstat === stat
        return this.stat(filepath);
      },

      async readdir(filepath: string): Promise<string[]> {
        const uri = toUri(filepath);
        return await FileSystem.readDirectoryAsync(uri);
      },

      async readlink(_filepath: string): Promise<string> {
        throw makeError("ENOENT", "Symlinks not supported");
      },

      async symlink(
        _target: string,
        _filepath: string
      ): Promise<void> {
        throw makeError("ENOENT", "Symlinks not supported");
      },

      async chmod(_filepath: string, _mode: number): Promise<void> {
        // No-op: expo-file-system doesn't support chmod
      },

      async rename(oldPath: string, newPath: string): Promise<void> {
        const fromUri = toUri(oldPath);
        const toUri2 = toUri(newPath);
        await FileSystem.moveAsync({ from: fromUri, to: toUri2 });
      },
    },
  };
}
