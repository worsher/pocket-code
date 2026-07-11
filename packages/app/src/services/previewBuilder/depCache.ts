// CDN 依赖缓存:纯 key 函数(vitest 测)+ expo-fs 薄读写(不测,惰性 require
// 以免 vitest 加载本文件时拖入 expo)。存 Paths.cache/preview-deps/<key>。

declare function require(name: string): any;

export function fnv1aHex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function cacheKeyForUrl(url: string): string {
  const tailRaw = url.slice(url.lastIndexOf("/") + 1);
  const tail = tailRaw.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 40) || "dep";
  return `${fnv1aHex(url)}-${tail}`;
}

const CACHE_DIR = "preview-deps";

export async function readCachedDep(url: string): Promise<string | null> {
  try {
    const { Paths, File } = require("expo-file-system");
    const f = new File(Paths.cache, CACHE_DIR, cacheKeyForUrl(url));
    if (!f.exists) return null;
    return await f.text();
  } catch {
    return null;
  }
}

export async function writeCachedDep(url: string, content: string): Promise<void> {
  try {
    const { Paths, Directory, File } = require("expo-file-system");
    const dir = new Directory(Paths.cache, CACHE_DIR);
    if (!dir.exists) dir.create({ idempotent: true, intermediates: true });
    const f = new File(dir, cacheKeyForUrl(url));
    if (!f.exists) f.create({ overwrite: true });
    f.write(content);
  } catch {
    // 缓存写失败不致命:下次仍会 fetch
  }
}
