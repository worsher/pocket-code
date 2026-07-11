// 裸引用(react、@x/y、react-dom/client)→ esm.sh URL(纯函数,TDD)。
// 版本读工作区根 package.json 的 dependencies/devDependencies(前者优先),
// 原样拼接(esm.sh 支持 ^/~ 等 semver range);查无则不带版本。

import { normalizeImport } from "./pathUtils";

export function isHttpUrl(s: string): boolean {
  return s.startsWith("http://") || s.startsWith("https://");
}

export function isRelative(s: string): boolean {
  return s.startsWith("./") || s.startsWith("../") || s.startsWith("/");
}

export function esmShUrl(specifier: string, pkgJsonText: string | null): string {
  const segs = specifier.split("/");
  const nameSegs = specifier.startsWith("@") ? 2 : 1;
  const pkgName = segs.slice(0, nameSegs).join("/");
  const subPath = segs.slice(nameSegs).join("/");

  let version: string | undefined;
  if (pkgJsonText) {
    try {
      const pkg = JSON.parse(pkgJsonText);
      version = pkg?.dependencies?.[pkgName] ?? pkg?.devDependencies?.[pkgName];
    } catch {
      // 非法 JSON:视为无版本
    }
  }

  const versioned = version ? `${pkgName}@${version}` : pkgName;
  return subPath
    ? `https://esm.sh/${versioned}/${subPath}`
    : `https://esm.sh/${versioned}`;
}

/**
 * http URL 相对解析(纯字符串实现)。
 * 禁用 new URL(path, base):RN/Hermes 的 URL polyfill 对相对基址解析不可靠,
 * vitest(node)能过但真机会 throw —— 本函数保证两端行为一致。
 */
export function joinHttpUrl(baseUrl: string, spec: string): string | null {
  const m = baseUrl.match(/^(https?:\/\/[^/]+)(\/[^?#]*)?/);
  if (!m) return null;
  const origin = m[1];
  const basePath = (m[2] ?? "/").slice(1); // 去前导 /,变"根相对文件路径"
  const norm = spec.startsWith("/")
    ? normalizeImport("x", spec) // "/a/b" 相对根;importer 占位任意顶层文件
    : normalizeImport(basePath === "" ? "index" : basePath, spec);
  return norm == null ? null : `${origin}/${norm}`;
}
