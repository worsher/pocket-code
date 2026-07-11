// RN 侧构建编排:builder WebView 的一切 resolve/load 决策都在这里(D5:
// 纯逻辑 RN 侧,WebView 哑执行器)。io 注入使本模块 vitest 全测。
// 已知限制(follow-up):不复制工作区 public/ 目录;dist 收 binary 产物不支持
// (v1 图片走 dataurl,产物只有 js/css/html)。
import { normalizeImport } from "./pathUtils";
import { parseEntryHtml, rewriteEntryHtml } from "./entryHtml";
import { isHttpUrl, isRelative, esmShUrl, joinHttpUrl } from "./bareImports";
import { parseBuilderMsg, type HostMsg } from "./types";

export interface BuilderIo {
  readTextFile(relPath: string): Promise<{ ok: boolean; content?: string; error?: string }>;
  readBinaryBase64(relPath: string): Promise<{ ok: boolean; base64?: string; error?: string }>;
  writeDistFile(relPath: string, content: string): Promise<{ ok: boolean; error?: string }>;
  readCache(url: string): Promise<string | null>;
  writeCache(url: string, content: string): Promise<void>;
}

export interface BuildCallbacks {
  sendToWebView(msg: HostMsg): void;
  onStatus(text: string): void;
  onSuccess(): void;
  onError(message: string): void;
}

const TEXT_LOADERS: Record<string, string> = {
  ".ts": "ts", ".tsx": "tsx", ".jsx": "jsx", ".js": "js", ".mjs": "js",
  ".css": "css", ".json": "json",
};
const BINARY_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".woff", ".woff2"];

function extOf(p: string): string {
  const clean = p.split("?")[0];
  const i = clean.lastIndexOf(".");
  return i === -1 ? "" : clean.slice(i).toLowerCase();
}

function httpLoader(url: string): string {
  return extOf(url) === ".css" ? "css" : "js";
}

/** esm.sh URL → 包名(错误文案用):纯字符串取路径首段去 @version 尾巴;scoped 包两段 */
function pkgNameFromUrl(url: string): string {
  const path = url.replace(/^https?:\/\/[^/]+\/?/, "").split("?")[0];
  const segs = path.split("/");
  const n = path.startsWith("@") ? 2 : 1;
  return segs.slice(0, n).join("/").replace(/@[^/@]*$/, "") || url;
}

export function createBuildSession(io: BuilderIo, cb: BuildCallbacks) {
  let entryHtml = "";
  let pkgJsonText: string | null = null;
  const distFiles: string[] = [];
  let finished = false;
  let dead = false;

  const send = (m: HostMsg) => { if (!finished && !dead) cb.sendToWebView(m); };
  const fail = (m: string) => { if (!finished && !dead) { finished = true; cb.onError(m); } };

  async function handleBuilderMessage(raw: string): Promise<void> {
    if (finished || dead) return;
    const m = parseBuilderMsg(raw);
    if (!m) return;

    switch (m.type) {
      case "ready": {
        const htmlRes = await io.readTextFile("index.html");
        const parsed = htmlRes.ok && htmlRes.content != null
          ? parseEntryHtml(htmlRes.content)
          : ({ ok: false, error: '入口缺失:需要 index.html + <script type="module" src=...>' } as const);
        if (!parsed.ok) { fail(parsed.error); return; }
        entryHtml = htmlRes.content!;
        const entryJs = normalizeImport("index.html", parsed.entrySrc);
        if (entryJs == null) { fail("入口路径越出工作区"); return; }
        const pkg = await io.readTextFile("package.json");
        pkgJsonText = pkg.ok && pkg.content != null ? pkg.content : null;
        cb.onStatus("构建中…");
        send({ type: "start", entryJs });
        return;
      }
      case "resolve": {
        const { id, path, importer } = m;
        if (isHttpUrl(path)) { send({ id, type: "resolved", path }); return; }
        if (isHttpUrl(importer)) {
          const joined = joinHttpUrl(importer, path);
          if (joined == null) send({ id, type: "resolved", error: "无法解析: " + path });
          else send({ id, type: "resolved", path: joined });
          return;
        }
        if (isRelative(path)) {
          const norm = normalizeImport(importer, path);
          if (norm == null) send({ id, type: "resolved", error: "引用越出工作区: " + path });
          else send({ id, type: "resolved", path: norm });
          return;
        }
        send({ id, type: "resolved", path: esmShUrl(path, pkgJsonText) });
        return;
      }
      case "load": {
        const { id, path } = m;
        if (isHttpUrl(path)) {
          const cached = await io.readCache(path);
          if (cached != null) send({ id, type: "loaded", contents: cached, loader: httpLoader(path) });
          else send({ id, type: "fetch", url: path });
          return;
        }
        const ext = extOf(path);
        if (BINARY_EXTS.includes(ext)) {
          const r = await io.readBinaryBase64(path);
          if (r.ok && r.base64 != null) send({ id, type: "loaded", contents: r.base64, loader: "dataurl", binary: true });
          else send({ id, type: "loaded", error: r.error ?? "读取失败: " + path });
          return;
        }
        const loader = TEXT_LOADERS[ext] ?? "text";
        const r = await io.readTextFile(path);
        if (r.ok && r.content != null) send({ id, type: "loaded", contents: r.content, loader });
        else send({ id, type: "loaded", error: r.error ?? "读取失败: " + path });
        return;
      }
      case "fetched": {
        const { id, url, ok, content } = m;
        if (ok && content != null) {
          await io.writeCache(url, content);
          send({ id, type: "loaded", contents: content, loader: httpLoader(url) });
        } else {
          send({ id, type: "loaded", error: "fetch 失败: " + url });
          fail(`依赖 ${pkgNameFromUrl(url)} 未缓存,首次构建需联网`);
        }
        return;
      }
      case "dist": {
        distFiles.push(m.path);
        const w = await io.writeDistFile(m.path, m.content);
        if (!w.ok) fail(w.error ?? "产物写入失败: " + m.path);
        return;
      }
      case "done": {
        const jsOut = distFiles.find((p) => p.endsWith(".js"));
        const cssOut = distFiles.find((p) => p.endsWith(".css"));
        if (!jsOut) { fail("构建无 JS 产物"); return; }
        const html = rewriteEntryHtml(entryHtml, { js: "./" + jsOut, css: cssOut ? "./" + cssOut : undefined });
        const w = await io.writeDistFile("index.html", html);
        if (!w.ok) { fail(w.error ?? "index.html 写入失败"); return; }
        finished = true;
        cb.onSuccess();
        return;
      }
      case "error":
        fail(m.message);
        return;
    }
  }

  return {
    handleBuilderMessage,
    cancelled: () => { dead = true; },
  };
}
