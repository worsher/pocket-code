import { describe, expect, it, vi } from "vitest";
import { createBuildSession, type BuilderIo } from "./orchestrator";
import type { HostMsg } from "./types";

const VITE_HTML = `<html><head></head><body><script type="module" src="/src/main.tsx"></script></body></html>`;

function makeIo(files: Record<string, string>, cache: Record<string, string> = {}): BuilderIo & { dist: Record<string, string>; cacheWrites: string[] } {
  const dist: Record<string, string> = {};
  const cacheWrites: string[] = [];
  return {
    dist, cacheWrites,
    readTextFile: async (p) => (p in files ? { ok: true, content: files[p] } : { ok: false, error: "no " + p }),
    readBinaryBase64: async (p) => (p in files ? { ok: true, base64: "QUJD" } : { ok: false, error: "no " + p }),
    writeDistFile: async (p, c) => { dist[p] = c; return { ok: true }; },
    readCache: async (u) => cache[u] ?? null,
    writeCache: async (u, c) => { cacheWrites.push(u); cache[u] = c; },
  };
}

function harness(io: BuilderIo) {
  const sent: HostMsg[] = [];
  const status: string[] = [];
  let success = 0; let error: string | null = null;
  const s = createBuildSession(io, {
    sendToWebView: (m) => sent.push(m),
    onStatus: (t) => status.push(t),
    onSuccess: () => { success++; },
    onError: (m) => { error = m; },
  });
  return { s, sent, get success() { return success; }, get error() { return error; } };
}

const msg = (o: object) => JSON.stringify(o);

describe("createBuildSession", () => {
  it("ready→start(入口从 index.html 解析并归一)", async () => {
    const io = makeIo({ "index.html": VITE_HTML, "package.json": "{}" });
    const h = harness(io);
    await h.s.handleBuilderMessage(msg({ type: "ready" }));
    expect(h.sent[0]).toEqual({ type: "start", entryJs: "src/main.tsx" });
  });

  it("无 index.html → 入口缺失逐字文案", async () => {
    const h = harness(makeIo({}));
    await h.s.handleBuilderMessage(msg({ type: "ready" }));
    expect(h.error).toBe('入口缺失:需要 index.html + <script type="module" src=...>');
  });

  it("resolve:相对/裸/http 三分流", async () => {
    const io = makeIo({ "index.html": VITE_HTML, "package.json": JSON.stringify({ dependencies: { react: "18.3.1" } }) });
    const h = harness(io);
    await h.s.handleBuilderMessage(msg({ type: "ready" }));
    await h.s.handleBuilderMessage(msg({ id: 1, type: "resolve", path: "./App.tsx", importer: "src/main.tsx" }));
    await h.s.handleBuilderMessage(msg({ id: 2, type: "resolve", path: "react", importer: "src/main.tsx" }));
    await h.s.handleBuilderMessage(msg({ id: 3, type: "resolve", path: "/react@18.3.1/es2022/react.mjs", importer: "https://esm.sh/react@18.3.1" }));
    expect(h.sent).toContainEqual({ id: 1, type: "resolved", path: "src/App.tsx" });
    expect(h.sent).toContainEqual({ id: 2, type: "resolved", path: "https://esm.sh/react@18.3.1" });
    expect(h.sent).toContainEqual({ id: 3, type: "resolved", path: "https://esm.sh/react@18.3.1/es2022/react.mjs" });
  });

  it("resolve:entry-point(importer 空串)原样回显工作区相对路径", async () => {
    const io = makeIo({ "index.html": VITE_HTML, "package.json": "{}" });
    const h = harness(io);
    await h.s.handleBuilderMessage(msg({ type: "ready" }));
    await h.s.handleBuilderMessage(msg({ id: 1, type: "resolve", path: "src/main.tsx", importer: "" }));
    expect(h.sent).toContainEqual({ id: 1, type: "resolved", path: "src/main.tsx" });
  });

  it("load 本地 tsx → loaded(loader=tsx);图片 → dataurl+binary", async () => {
    const io = makeIo({ "index.html": VITE_HTML, "src/App.tsx": "export {}", "src/logo.png": "PNG" });
    const h = harness(io);
    await h.s.handleBuilderMessage(msg({ type: "ready" }));
    await h.s.handleBuilderMessage(msg({ id: 1, type: "load", path: "src/App.tsx" }));
    await h.s.handleBuilderMessage(msg({ id: 2, type: "load", path: "src/logo.png" }));
    expect(h.sent).toContainEqual({ id: 1, type: "loaded", contents: "export {}", loader: "tsx" });
    expect(h.sent).toContainEqual({ id: 2, type: "loaded", contents: "QUJD", loader: "dataurl", binary: true });
  });

  it("load http:缓存命中直接 loaded;未中发 fetch,fetched 后写缓存并 loaded", async () => {
    const url = "https://esm.sh/react@18.3.1";
    const io = makeIo({ "index.html": VITE_HTML }, { [url]: "cached-js" });
    const h = harness(io);
    await h.s.handleBuilderMessage(msg({ type: "ready" }));
    await h.s.handleBuilderMessage(msg({ id: 1, type: "load", path: url }));
    expect(h.sent).toContainEqual({ id: 1, type: "loaded", contents: "cached-js", loader: "js" });

    const url2 = "https://esm.sh/other@1.0.0";
    await h.s.handleBuilderMessage(msg({ id: 2, type: "load", path: url2 }));
    expect(h.sent).toContainEqual({ id: 2, type: "fetch", url: url2 });
    await h.s.handleBuilderMessage(msg({ id: 2, type: "fetched", url: url2, ok: true, content: "fresh-js" }));
    expect(io.cacheWrites).toContain(url2);
    expect(h.sent).toContainEqual({ id: 2, type: "loaded", contents: "fresh-js", loader: "js" });
  });

  it("fetched 失败 → 依赖未缓存逐字文案(含包名)", async () => {
    const io = makeIo({ "index.html": VITE_HTML });
    const h = harness(io);
    await h.s.handleBuilderMessage(msg({ type: "ready" }));
    const url = "https://esm.sh/react@18.3.1";
    await h.s.handleBuilderMessage(msg({ id: 1, type: "load", path: url }));
    await h.s.handleBuilderMessage(msg({ id: 1, type: "fetched", url, ok: false, status: 0 }));
    expect(h.error).toBe("依赖 react 未缓存,首次构建需联网");
  });

  it("dist→done:写产物+改写 index.html(js/css 注入)→ onSuccess", async () => {
    const io = makeIo({ "index.html": VITE_HTML, "package.json": "{}" });
    const h = harness(io);
    await h.s.handleBuilderMessage(msg({ type: "ready" }));
    await h.s.handleBuilderMessage(msg({ type: "dist", path: "assets/main.js", content: "js!" }));
    await h.s.handleBuilderMessage(msg({ type: "dist", path: "assets/main.css", content: "css!" }));
    await h.s.handleBuilderMessage(msg({ type: "done", warnings: [] }));
    expect(io.dist["assets/main.js"]).toBe("js!");
    expect(io.dist["index.html"]).toContain('src="./assets/main.js"');
    expect(io.dist["index.html"]).toContain('href="./assets/main.css"');
    expect(h.success).toBe(1);
  });

  it("builder error 透传;终态后消息忽略;cancelled 后忽略", async () => {
    const io = makeIo({ "index.html": VITE_HTML, "package.json": "{}" });
    const h = harness(io);
    await h.s.handleBuilderMessage(msg({ type: "ready" }));
    await h.s.handleBuilderMessage(msg({ type: "error", message: "boom at src/App.tsx:3" }));
    expect(h.error).toBe("boom at src/App.tsx:3");
    const sentBefore = h.sent.length;
    await h.s.handleBuilderMessage(msg({ id: 9, type: "load", path: "src/App.tsx" }));
    expect(h.sent.length).toBe(sentBefore); // 终态后忽略

    const h2 = harness(io);
    h2.s.cancelled();
    await h2.s.handleBuilderMessage(msg({ type: "ready" }));
    expect(h2.sent.length).toBe(0);
  });

  it("非法消息忽略不 crash", async () => {
    const h = harness(makeIo({ "index.html": VITE_HTML }));
    await h.s.handleBuilderMessage("not json");
    await h.s.handleBuilderMessage('{"type":"hack"}');
    expect(h.error).toBeNull();
  });
});
