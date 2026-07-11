// 预览构建的 POSIX 路径工具(纯函数,不 import react-native/expo —— vitest 直测)。
// 路径均为工作区相对路径,不带前导 "./" 或 "/"。

export function dirnamePosix(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

/**
 * 以 importer 所在目录为基归一相对引用。
 * spec 以 "/" 开头 → 相对工作区根;"./"、"../" → 相对 importer 目录。
 * ".." 穿透顶层(越出工作区根)→ null。
 */
export function normalizeImport(importer: string, spec: string): string | null {
  const base = spec.startsWith("/") ? "" : dirnamePosix(importer);
  const raw = spec.startsWith("/") ? spec.slice(1) : spec;
  const parts: string[] = base === "" ? [] : base.split("/");
  for (const seg of raw.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join("/");
}
