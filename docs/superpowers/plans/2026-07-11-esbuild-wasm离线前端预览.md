# esbuild-wasm 离线前端预览 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PreviewTab 一键把手机工作区的前端项目(Vite 惯例)在 WebView 内用 esbuild-wasm 打包,产物落盘 `dist/`,以 `file://` 渲染;npm 依赖走 esm.sh + 本地缓存,缓存命中后真离线。

**Architecture:** 纯逻辑全在 RN 侧(`src/services/previewBuilder/` 纯 TS,vitest 全测):入口 html 解析、resolve 决策、esm.sh URL、缓存、bridge 协议、构建编排(io 注入可测)。WebView 是哑执行器(`builder.html` 内联 esbuild 的 browser.js + 薄胶水,onResolve/onLoad 全部 bridge 回 RN)。产物写 `<workspace>/dist/`,PreviewTab 现有 WebView `file://` 加载。Spec:`docs/superpowers/specs/2026-07-11-esbuild-wasm离线前端预览-design.md`。

**Tech Stack:** TypeScript、React Native (Expo 54)、react-native-webview 13、esbuild-wasm **0.28.1(exact pin)**、expo-file-system 19(`File.base64()`/`Paths.cache`)、expo-asset(新增依赖)、vitest(**不是 jest**)。

## Global Constraints

- 分支:`feature/offline-preview`(从 master 切出;执行者若已在此分支则直接工作)。
- **既有远程预览(URL/隧道)行为零变化**:PreviewTab 的 URL 输入/Go/前进后退/隧道改写逻辑不动。
- **纯逻辑不碰 RN/expo**:`previewBuilder/` 下除 `ioExpo.ts`、`assets.ts` 两个薄适配文件外,一律不得 import `react-native`/`expo-*`(vitest node 环境直测)。
- esbuild-wasm 版本 **0.28.1**,`pnpm --filter @pocket-code/app add -DE esbuild-wasm@0.28.1`(exact)。
- 生成物 gitignore:`packages/app/assets/preview-builder/builder.html` 与 `esbuild.wasm` 不进 git;模板 `builder-template.html` 与同步脚本进 git;postinstall 自动重建生成物。
- 错误文案(逐字,来自 spec §5):入口缺失 → `入口缺失:需要 index.html + <script type="module" src=...>`;依赖未缓存离线 → `依赖 <名> 未缓存,首次构建需联网`;初始化失败 → `构建器初始化失败`。
- 验证门:`cd packages/app && npx tsc --noEmit` 0 错误;`pnpm --filter @pocket-code/app test` 全绿;末任务 `pnpm test:all` EXIT 0。
- 人工验收(Android/iOS Expo Go 跑通 react 最小 Vite 项目)为**后置项**,不是任务门禁;实现者在报告里注明未做即可。
- 提交信息中文,`feat:`/`docs:` 前缀,结尾带:

```
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VTWQvYMuNm4MxVzL3QQyK5
```

## File Structure(全景)

| 文件 | 动作 | 任务 |
|---|---|---|
| `packages/app/src/services/previewBuilder/pathUtils.ts` + `.test.ts` | 建 | T1 |
| `packages/app/src/services/previewBuilder/entryHtml.ts` + `.test.ts` | 建 | T1 |
| `packages/app/src/services/previewBuilder/bareImports.ts` + `.test.ts` | 建 | T2 |
| `packages/app/src/services/previewBuilder/types.ts` | 建(bridge 协议类型 + parse) | T3 |
| `packages/app/src/services/previewBuilder/types.test.ts` | 建 | T3 |
| `packages/app/src/services/previewBuilder/depCache.ts` + `.test.ts` | 建(纯 key 函数 + expo-fs 薄封装) | T4 |
| `packages/app/src/services/previewBuilder/orchestrator.ts` + `.test.ts` | 建(核心编排,io 注入) | T5 |
| `packages/app/assets/preview-builder/builder-template.html` | 建(手写模板,胶水 JS 内联) | T6 |
| `packages/app/scripts/sync-preview-builder-assets.mjs` | 建(postinstall 同步脚本) | T6 |
| `packages/app/metro.config.js` | 建(assetExts + wasm/html) | T6 |
| `packages/app/package.json` | 改(deps + postinstall) | T6 |
| `packages/app/.gitignore` | 改(生成物) | T6 |
| `packages/app/src/services/previewBuilder/ioExpo.ts` | 建(BuilderIo 的 expo 实现,薄) | T7 |
| `packages/app/src/services/previewBuilder/assets.ts` | 建(asset→cache 固定目录复制,薄) | T7 |
| `packages/app/src/components/PreviewTab/index.tsx` | 改(构建按钮/状态/隐藏 builder WebView/file:// props) | T7 |
| `packages/app/App.tsx` | 改(传 projectId) | T7 |
| `plan.md` | 改(待办 #2 完成态) | T7 |

任务序 = 依赖序:T1/T2/T3/T4 皆纯模块(彼此独立,但按序做);T5 消费 T1-T4 全部;T6 独立(静态资产管线);T7 集成全部。

---

### Task 1: pathUtils + entryHtml(纯函数,TDD)

**Files:**
- Create: `packages/app/src/services/previewBuilder/pathUtils.ts`
- Create: `packages/app/src/services/previewBuilder/pathUtils.test.ts`
- Create: `packages/app/src/services/previewBuilder/entryHtml.ts`
- Create: `packages/app/src/services/previewBuilder/entryHtml.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces(T5 依赖,签名逐字):
  - `dirnamePosix(p: string): string` — `"src/a/b.ts"` → `"src/a"`;`"a.ts"` → `""`。
  - `normalizeImport(importer: string, spec: string): string | null` — 以 importer 所在目录为基,归一 `./`/`../`(折叠段);spec 以 `/` 开头则相对工作区根(去掉前导 `/`);越出根(`..` 穿透顶层)返回 `null`。返回值不带前导 `./` 或 `/`。
  - `parseEntryHtml(html: string): { ok: true; entrySrc: string } | { ok: false; error: string }` — 取第一个 `<script type="module" src="...">` 的 src(单双引号皆可,属性顺序任意);无则 `{ ok:false, error:"入口缺失:需要 index.html + <script type=\"module\" src=...>" }`。
  - `rewriteEntryHtml(html: string, out: { js: string; css?: string }): string` — 把该 module script 的 src 替换为 `out.js`;`out.css` 存在时在 `</head>` 前插入 `<link rel="stylesheet" href="<out.css>">`(html 无 `</head>` 则插在 module script 前一行)。

**注意(给零上下文实现者):** 本文件跑在 RN(Hermes)侧 —— **没有 DOMParser**,必须正则/字符串实现。测试是 vitest(`pnpm --filter @pocket-code/app test` 跑 `src` 下所有 `.test.ts`),node 环境,故本模块禁止 import react-native/expo。

- [ ] **Step 1: 写失败测试 `pathUtils.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { dirnamePosix, normalizeImport } from "./pathUtils";

describe("dirnamePosix", () => {
  it("常规路径取目录", () => {
    expect(dirnamePosix("src/a/b.ts")).toBe("src/a");
  });
  it("顶层文件目录为空串", () => {
    expect(dirnamePosix("a.ts")).toBe("");
  });
});

describe("normalizeImport", () => {
  it("同目录相对引用", () => {
    expect(normalizeImport("src/main.tsx", "./App.tsx")).toBe("src/App.tsx");
  });
  it("上级目录引用并折叠", () => {
    expect(normalizeImport("src/pages/Home.tsx", "../lib/util.ts")).toBe("src/lib/util.ts");
  });
  it("以 / 开头视为工作区根", () => {
    expect(normalizeImport("src/main.tsx", "/src/style.css")).toBe("src/style.css");
  });
  it("越出根返回 null", () => {
    expect(normalizeImport("main.tsx", "../../etc/passwd")).toBeNull();
  });
  it("多余 ./ 与重复斜杠折叠", () => {
    expect(normalizeImport("src/main.tsx", ".//./App.tsx")).toBe("src/App.tsx");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @pocket-code/app test`
Expected: FAIL — `Cannot find module './pathUtils'`。

- [ ] **Step 3: 实现 `pathUtils.ts`**

```ts
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @pocket-code/app test`
Expected: pathUtils 7 例 PASS。

- [ ] **Step 5: 写失败测试 `entryHtml.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { parseEntryHtml, rewriteEntryHtml } from "./entryHtml";

const VITE_HTML = `<!doctype html>
<html>
  <head><title>t</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>`;

describe("parseEntryHtml", () => {
  it("取第一个 module script 的 src", () => {
    expect(parseEntryHtml(VITE_HTML)).toEqual({ ok: true, entrySrc: "/src/main.tsx" });
  });
  it("单引号与属性乱序也能取到", () => {
    const html = `<script src='./m.js' type="module"></script>`;
    expect(parseEntryHtml(html)).toEqual({ ok: true, entrySrc: "./m.js" });
  });
  it("多个 module script 取第一个", () => {
    const html = `<script type="module" src="/a.js"></script><script type="module" src="/b.js"></script>`;
    expect(parseEntryHtml(html)).toEqual({ ok: true, entrySrc: "/a.js" });
  });
  it("无 module script 报入口缺失(逐字文案)", () => {
    const r = parseEntryHtml("<html><body>hi</body></html>");
    expect(r).toEqual({ ok: false, error: '入口缺失:需要 index.html + <script type="module" src=...>' });
  });
});

describe("rewriteEntryHtml", () => {
  it("替换 module script src", () => {
    const out = rewriteEntryHtml(VITE_HTML, { js: "./assets/main.js" });
    expect(out).toContain('src="./assets/main.js"');
    expect(out).not.toContain("/src/main.tsx");
  });
  it("有 css 时在 </head> 前插 link", () => {
    const out = rewriteEntryHtml(VITE_HTML, { js: "./assets/main.js", css: "./assets/main.css" });
    const headEnd = out.indexOf("</head>");
    const linkAt = out.indexOf('<link rel="stylesheet" href="./assets/main.css">');
    expect(linkAt).toBeGreaterThan(-1);
    expect(linkAt).toBeLessThan(headEnd);
  });
  it("无 </head> 时 link 插在 script 前", () => {
    const html = `<div></div><script type="module" src="/m.js"></script>`;
    const out = rewriteEntryHtml(html, { js: "./assets/m.js", css: "./assets/m.css" });
    expect(out.indexOf("stylesheet")).toBeLessThan(out.indexOf("./assets/m.js"));
  });
});
```

- [ ] **Step 6: 跑测试确认失败**

Run: `pnpm --filter @pocket-code/app test`
Expected: FAIL — `Cannot find module './entryHtml'`。

- [ ] **Step 7: 实现 `entryHtml.ts`**

```ts
// index.html 入口解析与产物回写(纯字符串/正则 —— Hermes 无 DOMParser)。

const MODULE_SCRIPT_RE =
  /<script\b[^>]*\btype\s*=\s*["']module["'][^>]*>/i;
const SRC_RE = /\bsrc\s*=\s*["']([^"']+)["']/i;

export function parseEntryHtml(
  html: string
): { ok: true; entrySrc: string } | { ok: false; error: string } {
  const tag = html.match(MODULE_SCRIPT_RE);
  if (tag) {
    const src = tag[0].match(SRC_RE);
    if (src) return { ok: true, entrySrc: src[1] };
  }
  return {
    ok: false,
    error: '入口缺失:需要 index.html + <script type="module" src=...>',
  };
}

export function rewriteEntryHtml(
  html: string,
  out: { js: string; css?: string }
): string {
  let result = html.replace(MODULE_SCRIPT_RE, (tag) =>
    tag.replace(SRC_RE, `src="${out.js}"`)
  );
  if (out.css) {
    const link = `<link rel="stylesheet" href="${out.css}">`;
    if (result.includes("</head>")) {
      result = result.replace("</head>", `${link}\n</head>`);
    } else {
      result = result.replace(MODULE_SCRIPT_RE, (tag) => `${link}\n${tag}`);
    }
  }
  return result;
}
```

- [ ] **Step 8: 跑测试确认通过 + tsc**

Run: `pnpm --filter @pocket-code/app test && cd packages/app && npx tsc --noEmit && cd ../..`
Expected: 全 PASS;tsc 0 错误。

- [ ] **Step 9: Commit**

```bash
git add packages/app/src/services/previewBuilder/
git commit -m "feat(app): previewBuilder 路径工具与入口 html 解析/回写(纯函数,离线预览 T1)"
```

---

### Task 2: bareImports — 裸引用 → esm.sh URL(纯函数,TDD)

**Files:**
- Create: `packages/app/src/services/previewBuilder/bareImports.ts`
- Create: `packages/app/src/services/previewBuilder/bareImports.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces(T5 依赖,签名逐字):
  - `isHttpUrl(s: string): boolean` — `http://`/`https://` 前缀。
  - `isRelative(s: string): boolean` — `./`、`../`、`/` 前缀。
  - `esmShUrl(specifier: string, pkgJsonText: string | null): string` — 裸引用映射:包名 = 首段(scoped `@x/y` 为前两段),子路径拼在版本后;版本从 pkgJson 的 `dependencies`/`devDependencies` 查包名(dependencies 优先),版本串原样使用(含 `^`/`~`,esm.sh 支持 semver range);查无/pkgJson 为 null 或非法 JSON → 不带版本。
  - `joinHttpUrl(baseUrl: string, spec: string): string | null` — http URL 相对解析(esm.sh 模块内部的 `/x` 与 `./x` 子引用):**纯字符串实现,禁用 `new URL(path, base)`**(RN/Hermes 的 URL polyfill 相对基址解析不可靠,真机会 throw)。spec 以 `/` 开头 → origin + 归一路径;`./`/`../` → 相对 base 路径目录归一;越出根 → null。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { isHttpUrl, isRelative, esmShUrl } from "./bareImports";

const PKG = JSON.stringify({
  dependencies: { react: "^18.3.1", "react-dom": "^18.3.1", "@tanstack/react-query": "5.0.0" },
  devDependencies: { vite: "^5.0.0" },
});

describe("isHttpUrl / isRelative", () => {
  it("http(s) 判定", () => {
    expect(isHttpUrl("https://esm.sh/react")).toBe(true);
    expect(isHttpUrl("./a.ts")).toBe(false);
  });
  it("相对/绝对路径判定", () => {
    expect(isRelative("./a.ts")).toBe(true);
    expect(isRelative("../a.ts")).toBe(true);
    expect(isRelative("/src/a.ts")).toBe(true);
    expect(isRelative("react")).toBe(false);
  });
});

describe("esmShUrl", () => {
  it("依赖表有版本则带版本", () => {
    expect(esmShUrl("react", PKG)).toBe("https://esm.sh/react@^18.3.1");
  });
  it("子路径拼在版本后", () => {
    expect(esmShUrl("react-dom/client", PKG)).toBe("https://esm.sh/react-dom@^18.3.1/client");
  });
  it("scoped 包名取前两段", () => {
    expect(esmShUrl("@tanstack/react-query", PKG)).toBe("https://esm.sh/@tanstack/react-query@5.0.0");
  });
  it("devDependencies 也查得到", () => {
    expect(esmShUrl("vite", PKG)).toBe("https://esm.sh/vite@^5.0.0");
  });
  it("查无版本则不带", () => {
    expect(esmShUrl("lodash", PKG)).toBe("https://esm.sh/lodash");
  });
  it("pkgJson null/非法 JSON 不带版本", () => {
    expect(esmShUrl("react", null)).toBe("https://esm.sh/react");
    expect(esmShUrl("react", "{oops")).toBe("https://esm.sh/react");
  });
});

describe("joinHttpUrl", () => {
  it("绝对路径 spec 拼 origin", () => {
    expect(joinHttpUrl("https://esm.sh/react@18.3.1", "/react@18.3.1/es2022/react.mjs"))
      .toBe("https://esm.sh/react@18.3.1/es2022/react.mjs");
  });
  it("./ 相对 base 路径目录", () => {
    expect(joinHttpUrl("https://esm.sh/react@18.3.1/es2022/react.mjs", "./jsx-runtime.mjs"))
      .toBe("https://esm.sh/react@18.3.1/es2022/jsx-runtime.mjs");
  });
  it("../ 上跳一级", () => {
    expect(joinHttpUrl("https://esm.sh/a/b/c.mjs", "../d.mjs")).toBe("https://esm.sh/a/d.mjs");
  });
  it("越出根返回 null;非 http base 返回 null", () => {
    expect(joinHttpUrl("https://esm.sh/a.mjs", "../../x.mjs")).toBeNull();
    expect(joinHttpUrl("not-a-url", "./x")).toBeNull();
  });
});
```

(测试文件的 import 行相应为 `import { isHttpUrl, isRelative, esmShUrl, joinHttpUrl } from "./bareImports";`。)

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @pocket-code/app test`
Expected: FAIL — `Cannot find module './bareImports'`。

- [ ] **Step 3: 实现**

```ts
// 裸引用(react、@x/y、react-dom/client)→ esm.sh URL(纯函数)。
// 版本读工作区根 package.json 的 dependencies/devDependencies(前者优先),
// 原样拼接(esm.sh 支持 ^/~ 等 semver range);查无则不带版本。

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
```

(文件顶部相应加 `import { normalizeImport } from "./pathUtils";`。)

- [ ] **Step 4: 跑测试确认通过 + Commit**

Run: `pnpm --filter @pocket-code/app test`
Expected: 全 PASS。

```bash
git add packages/app/src/services/previewBuilder/bareImports.ts packages/app/src/services/previewBuilder/bareImports.test.ts
git commit -m "feat(app): previewBuilder 裸引用→esm.sh URL 映射(版本读 package.json,离线预览 T2)"
```

---

### Task 3: bridge 协议 types + 消息校验(纯函数,TDD)

**Files:**
- Create: `packages/app/src/services/previewBuilder/types.ts`
- Create: `packages/app/src/services/previewBuilder/types.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces(T5/T6/T7 依赖,类型逐字):

```ts
// WebView(builder)→ RN
export type BuilderMsg =
  | { type: "ready" }
  | { id: number; type: "resolve"; path: string; importer: string }
  | { id: number; type: "load"; path: string }
  | { id: number; type: "fetched"; url: string; ok: boolean; status?: number; content?: string }
  | { type: "dist"; path: string; content: string }
  | { type: "done"; warnings: string[] }
  | { type: "error"; message: string };

// RN → WebView(builder)
export type HostMsg =
  | { type: "start"; entryJs: string }
  | { id: number; type: "resolved"; path?: string; error?: string }
  | { id: number; type: "loaded"; contents?: string; loader?: string; binary?: boolean; error?: string }
  | { id: number; type: "fetch"; url: string };

export function parseBuilderMsg(raw: string): BuilderMsg | null;
```

**协议语义(给 T5/T6 的共同契约):** 一个 `load{id}` 可能先收到 `fetch{id,url}` 指令(builder 去 `fetch(url)` 后回 `fetched{id,...}`),再收到最终 `loaded{id,...}` —— builder 的 pending 表以 `resolved`/`loaded` 为终结。`loaded.binary === true` 时 `contents` 为 base64,builder 侧转 Uint8Array 交 esbuild。取消 = RN 直接卸载 WebView,无协议消息。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { parseBuilderMsg } from "./types";

describe("parseBuilderMsg", () => {
  it("合法 ready", () => {
    expect(parseBuilderMsg('{"type":"ready"}')).toEqual({ type: "ready" });
  });
  it("合法 resolve(带 id/path/importer)", () => {
    expect(parseBuilderMsg('{"id":1,"type":"resolve","path":"./a","importer":"src/main.tsx"}'))
      .toEqual({ id: 1, type: "resolve", path: "./a", importer: "src/main.tsx" });
  });
  it("合法 dist/done/error", () => {
    expect(parseBuilderMsg('{"type":"dist","path":"assets/main.js","content":"x"}')).not.toBeNull();
    expect(parseBuilderMsg('{"type":"done","warnings":[]}')).not.toBeNull();
    expect(parseBuilderMsg('{"type":"error","message":"boom"}')).not.toBeNull();
  });
  it("非 JSON 返回 null", () => {
    expect(parseBuilderMsg("not json")).toBeNull();
  });
  it("未知 type 返回 null", () => {
    expect(parseBuilderMsg('{"type":"hack"}')).toBeNull();
  });
  it("resolve 缺 id 返回 null", () => {
    expect(parseBuilderMsg('{"type":"resolve","path":"./a","importer":"x"}')).toBeNull();
  });
  it("dist 缺 content 返回 null", () => {
    expect(parseBuilderMsg('{"type":"dist","path":"a.js"}')).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @pocket-code/app test`
Expected: FAIL — `Cannot find module './types'`。

- [ ] **Step 3: 实现 `types.ts`**

```ts
// builder WebView ↔ RN 的 bridge 协议(单一 JSON 信封)。
// 校验入站(builder→RN)消息形状;出站 HostMsg 由 TS 类型约束。

export type BuilderMsg =
  | { type: "ready" }
  | { id: number; type: "resolve"; path: string; importer: string }
  | { id: number; type: "load"; path: string }
  | { id: number; type: "fetched"; url: string; ok: boolean; status?: number; content?: string }
  | { type: "dist"; path: string; content: string }
  | { type: "done"; warnings: string[] }
  | { type: "error"; message: string };

export type HostMsg =
  | { type: "start"; entryJs: string }
  | { id: number; type: "resolved"; path?: string; error?: string }
  | { id: number; type: "loaded"; contents?: string; loader?: string; binary?: boolean; error?: string }
  | { id: number; type: "fetch"; url: string };

function isNum(v: unknown): v is number { return typeof v === "number"; }
function isStr(v: unknown): v is string { return typeof v === "string"; }

export function parseBuilderMsg(raw: string): BuilderMsg | null {
  let m: any;
  try { m = JSON.parse(raw); } catch { return null; }
  if (!m || typeof m !== "object") return null;
  switch (m.type) {
    case "ready": return { type: "ready" };
    case "resolve":
      return isNum(m.id) && isStr(m.path) && isStr(m.importer)
        ? { id: m.id, type: "resolve", path: m.path, importer: m.importer } : null;
    case "load":
      return isNum(m.id) && isStr(m.path) ? { id: m.id, type: "load", path: m.path } : null;
    case "fetched":
      return isNum(m.id) && isStr(m.url) && typeof m.ok === "boolean"
        ? { id: m.id, type: "fetched", url: m.url, ok: m.ok, status: m.status, content: m.content } : null;
    case "dist":
      return isStr(m.path) && isStr(m.content) ? { type: "dist", path: m.path, content: m.content } : null;
    case "done":
      return Array.isArray(m.warnings) ? { type: "done", warnings: m.warnings.filter(isStr) } : null;
    case "error":
      return isStr(m.message) ? { type: "error", message: m.message } : null;
    default: return null;
  }
}
```

- [ ] **Step 4: 跑测试确认通过 + Commit**

Run: `pnpm --filter @pocket-code/app test`
Expected: 全 PASS。

```bash
git add packages/app/src/services/previewBuilder/types.ts packages/app/src/services/previewBuilder/types.test.ts
git commit -m "feat(app): previewBuilder bridge 协议类型与入站校验(离线预览 T3)"
```

---

### Task 4: depCache — 缓存 key(纯)+ expo-fs 读写(薄)

**Files:**
- Create: `packages/app/src/services/previewBuilder/depCache.ts`
- Create: `packages/app/src/services/previewBuilder/depCache.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces(T5/T7 依赖):
  - `fnv1aHex(s: string): string` — 32-bit FNV-1a,8 位小写 hex(左补零)。
  - `cacheKeyForUrl(url: string): string` — `<fnv1aHex(url)>-<尾段清洗>`;尾段 = URL 最后一个 `/` 后的部分,仅保留 `[a-zA-Z0-9._-]`,截断 40 字符,空则用 `dep`。
  - `readCachedDep(url: string): Promise<string | null>`、`writeCachedDep(url: string, content: string): Promise<void>` — 存取 `Paths.cache/preview-deps/<cacheKey>`。**此二函数 import expo-file-system,不进 vitest**;文件顶部注释声明本文件是"纯 key + 薄 fs"混合,测试只覆盖纯部分。

**设计说明:** RN 无 node crypto;缓存 key 无安全诉求,FNV-1a 足够,且加可读尾段便于调试翻缓存目录。**注意 vitest 会加载整个文件 —— expo import 必须惰性**(在函数体内 `require`),否则纯函数测试都跑不起来。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { fnv1aHex, cacheKeyForUrl } from "./depCache";

describe("fnv1aHex", () => {
  it("已知向量", () => {
    // FNV-1a 32-bit 标准向量
    expect(fnv1aHex("")).toBe("811c9dc5");
    expect(fnv1aHex("a")).toBe("e40c292c");
    expect(fnv1aHex("foobar")).toBe("bf9cf968");
  });
  it("不同输入不同输出", () => {
    expect(fnv1aHex("https://esm.sh/react@18")).not.toBe(fnv1aHex("https://esm.sh/react@19"));
  });
});

describe("cacheKeyForUrl", () => {
  it("哈希+可读尾段(@ 不在安全字符集,被清洗)", () => {
    const key = cacheKeyForUrl("https://esm.sh/react@18.3.1");
    expect(key).toMatch(/^[0-9a-f]{8}-react18\.3\.1$/);
  });
  it("尾段只留安全字符且截断", () => {
    const key = cacheKeyForUrl("https://esm.sh/@scope/pkg@1.0.0/sub/path?target=es2022&x=" + "y".repeat(100));
    const tail = key.slice(9);
    expect(tail.length).toBeLessThanOrEqual(40);
    expect(tail).toMatch(/^[a-zA-Z0-9._-]+$/);
  });
  it("尾段为空退化为 dep", () => {
    expect(cacheKeyForUrl("https://esm.sh/")).toMatch(/^[0-9a-f]{8}-dep$/);
  });
});
```

注意第一个 cacheKeyForUrl 用例:`@` 不在安全字符集,`react@18.3.1` 清洗为 `react18.3.1` —— 断言写 `/^[0-9a-f]{8}-react18\.3\.1$/`(上面代码里的三元是防呆,直接用后者)。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @pocket-code/app test`
Expected: FAIL — `Cannot find module './depCache'`。

- [ ] **Step 3: 实现**

```ts
// CDN 依赖缓存:纯 key 函数(vitest 测)+ expo-fs 薄读写(不测,惰性 require
// 以免 vitest 加载本文件时拖入 expo)。存 Paths.cache/preview-deps/<key>。

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
```

- [ ] **Step 4: 跑测试确认通过 + tsc + Commit**

Run: `pnpm --filter @pocket-code/app test && cd packages/app && npx tsc --noEmit && cd ../..`
Expected: 全 PASS;tsc 0 错误(require 在 RN/tsc 下合法;若 tsc 报 require 类型,改 `// eslint-disable-next-line @typescript-eslint/no-var-requires` 无效时用 `(globalThis as any).require` 不可 —— 正确做法是文件顶部 `declare function require(name: string): any;`)。

```bash
git add packages/app/src/services/previewBuilder/depCache.ts packages/app/src/services/previewBuilder/depCache.test.ts
git commit -m "feat(app): previewBuilder CDN 依赖缓存(FNV-1a key 纯测+expo-fs 惰性薄封装,离线预览 T4)"
```

---

### Task 5: orchestrator — RN 侧构建编排(io 注入,TDD 核心任务)

**Files:**
- Create: `packages/app/src/services/previewBuilder/orchestrator.ts`
- Create: `packages/app/src/services/previewBuilder/orchestrator.test.ts`

**Interfaces:**
- Consumes: T1 `normalizeImport`/`parseEntryHtml`/`rewriteEntryHtml`、T2 `isHttpUrl`/`isRelative`/`esmShUrl`/`joinHttpUrl`、T3 `BuilderMsg`/`HostMsg`/`parseBuilderMsg`。**禁用 `new URL(path, base)` 相对解析**(Hermes polyfill 不可靠,统一走 `joinHttpUrl`)。
- Produces(T7 依赖,签名逐字):

```ts
export interface BuilderIo {
  readTextFile(relPath: string): Promise<{ ok: boolean; content?: string; error?: string }>;
  readBinaryBase64(relPath: string): Promise<{ ok: boolean; base64?: string; error?: string }>;
  writeDistFile(relPath: string, content: string): Promise<{ ok: boolean; error?: string }>; // relPath 相对 dist/
  readCache(url: string): Promise<string | null>;
  writeCache(url: string, content: string): Promise<void>;
}
export interface BuildCallbacks {
  sendToWebView(msg: HostMsg): void;
  onStatus(text: string): void;      // 构建进度一句话
  onSuccess(): void;                  // dist 已写完
  onError(message: string): void;     // 终态错误(含 spec 逐字文案)
}
export function createBuildSession(io: BuilderIo, cb: BuildCallbacks): {
  handleBuilderMessage(raw: string): Promise<void>;
  cancelled: () => void;              // T7 卸载 WebView 时调,之后所有消息忽略
};
```

**编排规则(实现依据,逐条):**
1. 收 `ready`:`io.readTextFile("index.html")` → 失败或 `parseEntryHtml` 失败 → `cb.onError(<入口缺失逐字文案或读取错误>)`;成功 → 记 `entryHtml` 原文,`entryJs = normalizeImport("index.html", entrySrc)`(null → onError 越界文案 `入口路径越出工作区`),`sendToWebView({type:"start", entryJs})`,读 `package.json` 存 `pkgJsonText`(失败存 null),`onStatus("构建中…")`。
2. 收 `resolve{id,path,importer}`:
   - `isHttpUrl(path)` → `resolved{id, path}`(原样);
   - importer 是 http URL 且 path 相对 → `joinHttpUrl(importer, path)`,null → `resolved{id, error}`,否则 `resolved{id, path:结果}`;
   - `isRelative(path)` → `normalizeImport(importer, path)`,null → `resolved{id, error:"引用越出工作区: "+path}`,否则 `resolved{id, path:归一结果}`;
   - 其余(裸引用)→ `resolved{id, path: esmShUrl(path, pkgJsonText)}`。
3. 收 `load{id,path}`:
   - http URL → `io.readCache(path)`:命中 → `loaded{id, contents, loader: path 以 .css 结尾(忽略 query)? "css":"js"}`;未中 → `sendToWebView({id, type:"fetch", url:path})`(此 id 留待 fetched);
   - 本地路径按扩展名:`.ts→"ts"`、`.tsx→"tsx"`、`.jsx→"jsx"`、`.js/.mjs→"js"`、`.css→"css"`、`.json→"json"` → `io.readTextFile` → 成败映射 `loaded{id, contents, loader}` / `loaded{id, error}`;
   - `.png/.jpg/.jpeg/.gif/.webp/.svg/.woff/.woff2` → `io.readBinaryBase64` → `loaded{id, contents: base64, loader:"dataurl", binary:true}`;
   - 其他扩展 → `io.readTextFile` + `loader:"text"`。
4. 收 `fetched{id,url,ok,status,content}`:`ok && content != null` → `io.writeCache(url, content)` + `loaded{id, contents, loader:同 3 的 css/js 判定}`;`!ok` → 从 url 提取包名段(esm.sh 路径首段去版本)→ `loaded{id, error}` 且 `cb.onError("依赖 " + 名 + " 未缓存,首次构建需联网")`(终态)。
5. 收 `dist{path,content}`:累积 `distFiles.push(path)`,`io.writeDistFile(path, content)`,失败 → `onError`。
6. 收 `done{warnings}`:选 `jsOut` = distFiles 中第一个 `.js`,`cssOut` = 第一个 `.css`(可无);无 jsOut → onError(`构建无 JS 产物`);`rewriteEntryHtml(entryHtml, {js:"./"+jsOut, css: cssOut && "./"+cssOut})` → `io.writeDistFile("index.html", 改写结果)` → `cb.onSuccess()`。
7. 收 `error{message}` → `cb.onError(message)`。
8. `parseBuilderMsg` 返回 null → 忽略(不 crash)。`cancelled()` 调用后一切消息忽略。
9. 终态(onError/onSuccess)后再收消息一律忽略(幂等保护)。

- [ ] **Step 1: 写失败测试(用 fake io + 收集 sendToWebView,驱动完整消息序列)**

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @pocket-code/app test`
Expected: FAIL — `Cannot find module './orchestrator'`。

- [ ] **Step 3: 实现 `orchestrator.ts`**

```ts
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
```

- [ ] **Step 4: 跑测试确认通过 + tsc**

Run: `pnpm --filter @pocket-code/app test && cd packages/app && npx tsc --noEmit && cd ../..`
Expected: 全 PASS(orchestrator 9 例);tsc 0 错误。

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/services/previewBuilder/orchestrator.ts packages/app/src/services/previewBuilder/orchestrator.test.ts
git commit -m "feat(app): previewBuilder 构建编排(resolve/load/缓存/dist/html 回写全决策,io 注入全测,离线预览 T5)"
```

---

### Task 6: 静态资产管线 — 模板 + 同步脚本 + metro + 依赖

**Files:**
- Create: `packages/app/assets/preview-builder/builder-template.html`
- Create: `packages/app/scripts/sync-preview-builder-assets.mjs`
- Create: `packages/app/metro.config.js`
- Modify: `packages/app/package.json`(devDeps + dependencies + postinstall)
- Modify: `packages/app/.gitignore`

**Interfaces:**
- Consumes: T3 协议语义(胶水按 `BuilderMsg`/`HostMsg` 收发;RN→WebView 经全局 `window.__pcHost(jsonStr)`,WebView→RN 经 `window.ReactNativeWebView.postMessage(jsonStr)`)。
- Produces(T7 依赖):生成物 `assets/preview-builder/builder.html`(browser.js 已内联)与 `assets/preview-builder/esbuild.wasm`;metro 能把 `.wasm`/`.html` 当 asset require。

- [ ] **Step 1: 加依赖(exact pin esbuild-wasm;expo-asset 走 expo install 以对齐 SDK)**

```bash
pnpm --filter @pocket-code/app add -DE esbuild-wasm@0.28.1
cd packages/app && npx expo install expo-asset && cd ../..
```

验证:`grep -E '"esbuild-wasm"|"expo-asset"' packages/app/package.json` 显示 `"esbuild-wasm": "0.28.1"`(无 ^)与 expo-asset 一行。

- [ ] **Step 2: 写模板 `assets/preview-builder/builder-template.html`**

```html
<!doctype html>
<!-- builder:esbuild-wasm 哑执行器。一切 resolve/load 决策经 bridge 由 RN 侧
     orchestrator 做(见 src/services/previewBuilder/)。本文件是模板:
     {{ESBUILD_BROWSER_JS}} 由 scripts/sync-preview-builder-assets.mjs 内联替换,
     生成物 builder.html 不进 git。 -->
<html>
<head><meta charset="utf-8"></head>
<body>
<script>{{ESBUILD_BROWSER_JS}}</script>
<script>
(function () {
  "use strict";
  var pending = {}; // id -> {resolve}
  var nextId = 1;

  function post(obj) {
    window.ReactNativeWebView.postMessage(JSON.stringify(obj));
  }

  // RN → WebView 唯一入口(RN 用 injectJavaScript 调用)
  window.__pcHost = function (jsonStr) {
    var m;
    try { m = JSON.parse(jsonStr); } catch (e) { return; }
    if (m.type === "start") { runBuild(m.entryJs); return; }
    if (typeof m.id !== "number") return;
    if (m.type === "fetch") {
      // 同一 id 的中间指令:去拉 CDN,结果回 RN(RN 落缓存后再回最终 loaded)
      fetch(m.url).then(function (r) {
        if (!r.ok) { post({ id: m.id, type: "fetched", url: m.url, ok: false, status: r.status }); return null; }
        return r.text().then(function (t) { post({ id: m.id, type: "fetched", url: m.url, ok: true, status: r.status, content: t }); });
      }).catch(function () { post({ id: m.id, type: "fetched", url: m.url, ok: false, status: 0 }); });
      return;
    }
    // resolved / loaded:终结 pending
    var p = pending[m.id];
    if (p) { delete pending[m.id]; p.resolve(m); }
  };

  function rpc(type, payload) {
    return new Promise(function (resolve) {
      var id = nextId++;
      pending[id] = { resolve: resolve };
      payload.id = id; payload.type = type;
      post(payload);
    });
  }

  function b64ToU8(b64) {
    var bin = atob(b64), u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  function runBuild(entryJs) {
    esbuild.build({
      entryPoints: [entryJs],
      bundle: true,
      write: false,
      format: "esm",
      outdir: "assets",
      logLevel: "silent",
      plugins: [{
        name: "pc-bridge",
        setup: function (b) {
          b.onResolve({ filter: /.*/ }, function (args) {
            return rpc("resolve", { path: args.path, importer: args.importer || "" }).then(function (r) {
              if (r.error) return { errors: [{ text: r.error }] };
              return { path: r.path, namespace: "pc" };
            });
          });
          b.onLoad({ filter: /.*/, namespace: "pc" }, function (args) {
            return rpc("load", { path: args.path }).then(function (r) {
              if (r.error) return { errors: [{ text: r.error }] };
              return { contents: r.binary ? b64ToU8(r.contents) : r.contents, loader: r.loader };
            });
          });
        }
      }]
    }).then(function (result) {
      for (var i = 0; i < result.outputFiles.length; i++) {
        var f = result.outputFiles[i];
        post({ type: "dist", path: f.path.replace(/^\//, ""), content: f.text });
      }
      var warnings = [];
      for (var j = 0; j < result.warnings.length; j++) warnings.push(result.warnings[j].text);
      post({ type: "done", warnings: warnings });
    }).catch(function (e) {
      post({ type: "error", message: String((e && e.message) || e) });
    });
  }

  esbuild.initialize({ wasmURL: "./esbuild.wasm" })
    .then(function () { post({ type: "ready" }); })
    .catch(function (e) { post({ type: "error", message: "构建器初始化失败" }); });
})();
</script>
</body>
</html>
```

- [ ] **Step 3: 写同步脚本 `scripts/sync-preview-builder-assets.mjs`**

```js
// postinstall:从 node_modules/esbuild-wasm 生成 preview-builder 静态资产。
// 生成物(builder.html / esbuild.wasm)gitignore —— 避免 11MB 进仓;
// EAS/CI 装依赖时本脚本自动重建。模板 builder-template.html 进 git。
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..");
const outDir = join(appRoot, "assets", "preview-builder");
const wasmSrc = join(appRoot, "node_modules", "esbuild-wasm", "esbuild.wasm");
const browserJsSrc = join(appRoot, "node_modules", "esbuild-wasm", "lib", "browser.js");
const templateSrc = join(outDir, "builder-template.html");

if (!existsSync(wasmSrc) || !existsSync(browserJsSrc)) {
  console.error("[preview-builder] esbuild-wasm 未安装,跳过资产同步");
  process.exit(0); // 不阻断 install(比如 CI 只装部分包)
}
mkdirSync(outDir, { recursive: true });
copyFileSync(wasmSrc, join(outDir, "esbuild.wasm"));

const template = readFileSync(templateSrc, "utf8");
const browserJs = readFileSync(browserJsSrc, "utf8");
if (!template.includes("{{ESBUILD_BROWSER_JS}}")) {
  console.error("[preview-builder] 模板缺 {{ESBUILD_BROWSER_JS}} 占位符");
  process.exit(1);
}
// 用函数形式 replace,防 browser.js 内容中的 $ 序列被当替换模式
writeFileSync(join(outDir, "builder.html"), template.replace("{{ESBUILD_BROWSER_JS}}", () => browserJs));
console.log("[preview-builder] assets synced (builder.html + esbuild.wasm)");
```

- [ ] **Step 4: package.json 加 postinstall + .gitignore**

`packages/app/package.json` 的 `scripts` 加:

```json
"postinstall": "node scripts/sync-preview-builder-assets.mjs"
```

`packages/app/.gitignore` 追加两行:

```
assets/preview-builder/builder.html
assets/preview-builder/esbuild.wasm
```

- [ ] **Step 5: 写 `metro.config.js`**

```js
// metro 配置:让 .wasm/.html 可被 require 为 asset(preview-builder 静态资产)。
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
config.resolver.assetExts = [...config.resolver.assetExts, "wasm", "html"];

module.exports = config;
```

- [ ] **Step 6: 运行脚本验证生成物**

```bash
node packages/app/scripts/sync-preview-builder-assets.mjs
ls -la packages/app/assets/preview-builder/
grep -c "ESBUILD_BROWSER_JS" packages/app/assets/preview-builder/builder.html; echo "exit=$?"
git status --short packages/app/assets/
```

Expected:`builder.html`(~8MB,browser.js 已内联)与 `esbuild.wasm`(~11MB)存在;grep 计数 0(占位符已替换,grep exit 1);git status 只显示模板与 .gitignore 等**非生成物**(生成物被忽略)。

- [ ] **Step 7: 全验证 + Commit**

```bash
cd packages/app && npx tsc --noEmit && cd ../..
pnpm --filter @pocket-code/app test
git add packages/app/assets/preview-builder/builder-template.html packages/app/scripts/sync-preview-builder-assets.mjs packages/app/metro.config.js packages/app/package.json packages/app/.gitignore pnpm-lock.yaml
git commit -m "feat(app): preview-builder 静态资产管线(esbuild-wasm 0.28.1 内联模板+postinstall 同步+metro assetExts,离线预览 T6)"
```

Expected: tsc 0 错误、测试全绿(本任务不含新测试,回归即可)。

---

### Task 7: PreviewTab 集成 — io 适配 + 资产就位 + 构建 UI + file:// 加载

**Files:**
- Create: `packages/app/src/services/previewBuilder/ioExpo.ts`
- Create: `packages/app/src/services/previewBuilder/assets.ts`
- Modify: `packages/app/src/components/PreviewTab/index.tsx`
- Modify: `packages/app/App.tsx`(约 L417,传 projectId)
- Modify: `plan.md`(待办 #2)

**Interfaces:**
- Consumes: T5 `createBuildSession`/`BuilderIo`、T4 `readCachedDep`/`writeCachedDep`、T6 生成物 + `window.__pcHost` 约定、`localFileSystem` 的 `readLocalFile`/`writeLocalFile`/`getProjectWorkspaceRoot`/`getDefaultWorkspace`(均已存在,签名见 `src/services/localFileSystem.ts:33,60,86,107`)。
- Produces: 完整功能;无下游。

- [ ] **Step 1: 写 `ioExpo.ts`(BuilderIo 的 expo 实现,薄,不单测)**

```ts
// BuilderIo 的 expo 实现(薄适配,不进 vitest —— 决策逻辑全在 orchestrator)。
import { Paths, File } from "expo-file-system";
import { readLocalFile, writeLocalFile } from "../localFileSystem";
import { readCachedDep, writeCachedDep } from "./depCache";
import type { BuilderIo } from "./orchestrator";

export function createExpoIo(workspaceRoot: string | undefined): BuilderIo {
  return {
    readTextFile: (rel) => readLocalFile(rel, workspaceRoot),
    readBinaryBase64: async (rel) => {
      try {
        const root = workspaceRoot ?? new File(Paths.document, "workspace").uri;
        const f = new File(root, rel);
        if (!f.exists) return { ok: false, error: "File does not exist" };
        return { ok: true, base64: await f.base64() };
      } catch (e: any) {
        return { ok: false, error: e.message };
      }
    },
    writeDistFile: (rel, content) => writeLocalFile("dist/" + rel, content, workspaceRoot),
    readCache: readCachedDep,
    writeCache: writeCachedDep,
  };
}
```

- [ ] **Step 2: 写 `assets.ts`(builder 资产复制到固定目录,薄,不单测)**

**为什么要复制**:`Asset.downloadAsync()` 的落地文件是哈希名散文件,builder.html 里 `fetch("./esbuild.wasm")` 的相对引用会断。复制到 `Paths.cache/preview-builder/` 固定名同目录后,`file://` 加载与相对 fetch 都成立。

```ts
// builder 静态资产就位:把 metro asset(哈希名散文件)复制到
// Paths.cache/preview-builder/ 固定名同目录 —— builder.html 相对 fetch
// "./esbuild.wasm" 依赖同目录布局。幂等:已存在则跳过复制。
import { Asset } from "expo-asset";
import { Paths, Directory, File } from "expo-file-system";

export async function ensureBuilderAssets(): Promise<{ htmlUri: string; dirUri: string }> {
  const dir = new Directory(Paths.cache, "preview-builder");
  if (!dir.exists) dir.create({ idempotent: true, intermediates: true });

  const html = new File(dir, "builder.html");
  const wasm = new File(dir, "esbuild.wasm");

  if (!html.exists || !wasm.exists) {
    const [htmlAsset, wasmAsset] = await Promise.all([
      Asset.fromModule(require("../../../assets/preview-builder/builder.html")).downloadAsync(),
      Asset.fromModule(require("../../../assets/preview-builder/esbuild.wasm")).downloadAsync(),
    ]);
    if (!htmlAsset.localUri || !wasmAsset.localUri) throw new Error("构建器初始化失败");
    if (!html.exists) new File(htmlAsset.localUri).copy(html);
    if (!wasm.exists) new File(wasmAsset.localUri).copy(wasm);
  }
  return { htmlUri: html.uri, dirUri: dir.uri };
}
```

- [ ] **Step 3: PreviewTab 集成**

对 `packages/app/src/components/PreviewTab/index.tsx` 做以下修改(锚点按内容匹配,行号为现状参考):

① Props 加 projectId(现 L14-19):

```ts
interface Props {
  /** URL to load initially, set externally when a dev server is detected */
  initialUrl?: string;
  /** App 设置:relay 模式下用于构造中继隧道预览 URL */
  settings?: AppSettings;
  /** 当前项目 id:本地构建的工作区定位(getProjectWorkspaceRoot) */
  projectId?: string;
}

export default function PreviewTab({ initialUrl, settings, projectId }: Props) {
```

② 顶部加 imports(与现有 import 并列):

```ts
import { createBuildSession } from "../../services/previewBuilder/orchestrator";
import { createExpoIo } from "../../services/previewBuilder/ioExpo";
import { ensureBuilderAssets } from "../../services/previewBuilder/assets";
import { getProjectWorkspaceRoot, getDefaultWorkspace } from "../../services/localFileSystem";
```

(先查证 `getDefaultWorkspace` 的返回形态 —— `src/services/localFileSystem.ts` 有导出,useAgent.ts:9 在用;若它返回的不是 uri 字符串,就地用 `new Directory(Paths.document, "workspace").uri` 等价物,以该文件实际实现为准。)

③ 组件内加本地构建状态与逻辑(放在 `handleGoForward` 之后):

```ts
  // ── 本地构建(esbuild-wasm 离线预览) ──────────────────
  const [buildState, setBuildState] = useState<"idle" | "preparing" | "building">("idle");
  const [buildMsg, setBuildMsg] = useState<string | null>(null);
  const [builderHtmlUri, setBuilderHtmlUri] = useState<string | null>(null);
  const [builderDirUri, setBuilderDirUri] = useState<string | null>(null);
  const builderRef = useRef<WebView>(null);
  const sessionRef = useRef<ReturnType<typeof createBuildSession> | null>(null);

  const workspaceRoot = getProjectWorkspaceRoot(projectId);

  const teardownBuilder = useCallback(() => {
    sessionRef.current?.cancelled();
    sessionRef.current = null;
    setBuildState("idle");
  }, []);

  const handleLocalBuild = useCallback(async () => {
    if (buildState !== "idle") { teardownBuilder(); return; } // 再点=取消
    setBuildMsg(null);
    setBuildState("preparing");
    let assets: { htmlUri: string; dirUri: string };
    try {
      assets = await ensureBuilderAssets();
    } catch {
      setBuildMsg("构建器初始化失败");
      setBuildState("idle");
      return;
    }
    setBuilderHtmlUri(assets.htmlUri);
    setBuilderDirUri(assets.dirUri);

    const io = createExpoIo(workspaceRoot);
    sessionRef.current = createBuildSession(io, {
      sendToWebView: (msg) => {
        const payload = JSON.stringify(JSON.stringify(msg));
        builderRef.current?.injectJavaScript(`window.__pcHost(${payload}); true;`);
      },
      onStatus: (t) => setBuildMsg(t),
      onSuccess: () => {
        teardownBuilder();
        setBuildMsg(null);
        const distUrl = `${workspaceRoot ?? getDefaultWorkspace()}/dist/index.html`;
        setUrl(distUrl);
        setInputUrl(distUrl);
        setError(null);
      },
      onError: (m) => {
        teardownBuilder();
        setBuildMsg(m);
      },
    });
    setBuildState("building"); // builder WebView 由 building 状态触发挂载,onMessage 驱动 session
  }, [buildState, teardownBuilder, workspaceRoot]);

  // 初始化超时守卫:15s 未进入成功/失败即判初始化失败
  React.useEffect(() => {
    if (buildState !== "building") return;
    const t = setTimeout(() => {
      if (sessionRef.current) {
        teardownBuilder();
        setBuildMsg("构建器初始化失败");
      }
    }, 15000);
    return () => clearTimeout(t);
  }, [buildState, teardownBuilder]);
```

注意 `onSuccess` 中的超时豁免:成功/失败都会 `teardownBuilder()` 置 `sessionRef.current = null`,超时回调里判 `sessionRef.current` 仍在才报错 —— 已覆盖。

④ URL 栏加「构建」按钮(在 Go 按钮之后,`</View>`(urlBar)之前):

```tsx
        <TouchableOpacity
          style={[styles.goBtn, buildState !== "idle" && styles.buildBtnActive]}
          onPress={handleLocalBuild}
        >
          <Text style={styles.goBtnText}>{buildState === "idle" ? "构建" : "取消"}</Text>
        </TouchableOpacity>
```

⑤ 构建状态条(urlBar 的 `</View>` 之后、webViewContainer 之前):

```tsx
      {(buildState !== "idle" || buildMsg) && (
        <View style={styles.buildBar}>
          {buildState !== "idle" && <ActivityIndicator size="small" color="#FF9F0A" />}
          <Text style={styles.buildBarText} numberOfLines={2}>
            {buildMsg ?? (buildState === "preparing" ? "准备构建器…" : "构建中…")}
          </Text>
        </View>
      )}
```

⑥ 隐藏 builder WebView(webViewContainer 内、主 WebView 之后;1×1 不可见但保持 JS 运行):

```tsx
        {buildState === "building" && builderHtmlUri && builderDirUri && (
          <WebView
            ref={builderRef}
            source={{ uri: builderHtmlUri }}
            style={styles.builderHidden}
            javaScriptEnabled
            originWhitelist={["*"]}
            allowFileAccess
            allowFileAccessFromFileURLs
            allowingReadAccessToURL={builderDirUri}
            onMessage={(e) => { sessionRef.current?.handleBuilderMessage(e.nativeEvent.data); }}
            onError={() => { teardownBuilder(); setBuildMsg("构建器初始化失败"); }}
          />
        )}
```

⑦ 主 WebView 加 file:// 支持(现 L116-141 的 WebView 上追加 props;远程 URL 不受影响):

```tsx
            originWhitelist={["http://*", "https://*", "file://*"]}
            allowFileAccess
            allowFileAccessFromFileURLs
            allowingReadAccessToURL={workspaceRoot ?? getDefaultWorkspace()}
```

⑧ styles 追加(StyleSheet.create 内):

```ts
  buildBtnActive: {
    backgroundColor: "#FF9F0A",
  },
  buildBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: "#1C1C1E",
    borderBottomWidth: 0.5,
    borderBottomColor: "#38383A",
  },
  buildBarText: {
    color: "#FF9F0A",
    fontSize: 12,
    flex: 1,
    fontFamily: "monospace",
  },
  builderHidden: {
    position: "absolute",
    width: 1,
    height: 1,
    opacity: 0,
  },
```

- [ ] **Step 4: App.tsx 传 projectId(现 L417)**

```tsx
          <PreviewTab initialUrl={previewUrl} settings={settings} projectId={currentProject?.id} />
```

- [ ] **Step 5: plan.md 待办 #2 更新**

把 `plan.md` 待办列表第 2 条:

```markdown
2. **esbuild-wasm 离线前端预览**（模式 B/C）。
```

改为:

```markdown
2. ~~**esbuild-wasm 离线前端预览**（模式 B/C）~~(✅ 2026-07-11 完成:PreviewTab「构建」→ WebView 内 esbuild-wasm 打包 → dist file:// 渲染;esm.sh 依赖缓存,缓存命中真离线;真机人工验收后置。spec/plan 见 docs/superpowers/{specs,plans}/2026-07-11-esbuild-wasm离线前端预览*)。
```

- [ ] **Step 6: 全量验证**

```bash
cd packages/app && npx tsc --noEmit && cd ../..
pnpm test:all
```

Expected: tsc 0 错误;test:all EXIT 0。既有 PreviewTab 测试(tunnelUrl.test.ts)不受影响。

- [ ] **Step 7: Commit**

```bash
git add packages/app/src/services/previewBuilder/ioExpo.ts packages/app/src/services/previewBuilder/assets.ts packages/app/src/components/PreviewTab/index.tsx packages/app/App.tsx plan.md
git commit -m "feat(app): PreviewTab 本地构建集成(builder WebView+io 适配+file:// 渲染+构建状态条,离线预览 T7)"
```

**人工验收(后置,报告注明未做即可):** Android/iOS Expo Go → 工作区放最小 Vite react 项目 → 「构建」→ 首次联网成功渲染 → 飞行模式再构建(缓存命中)成功 → 重进 App 直接 file:// 打开 dist。

---

## Self-Review 记录(plan 定稿前自查)

1. **Spec 覆盖**:D1(CDN+缓存)→ T4+T5 规则 3/4 + T6 胶水 fetch;D2(落盘 dist→file://)→ T5 规则 5/6 + T7 ⑥⑦;D3(Vite 入口)→ T1 entryHtml + T5 规则 1;D4(PreviewTab 入口+手动触发)→ T7 ④;D5(纯逻辑 RN 侧)→ T1-T5 全纯 + T6 胶水薄 + Global Constraints 禁 RN import;D6(构建对象=项目工作区)→ T7 workspaceRoot;spec §5 错误表 → T5 规则 1/4 + T7 超时守卫/onError(逐字文案在 Global Constraints);§6 平台约束 → T6(metro/postinstall/gitignore)+ T7 ⑥⑦ file:// props + assets.ts 固定目录(Expo Go 哈希名陷阱);§7 测试策略 → T1-T5 用例逐项对应;§9 范围外 → orchestrator 顶部注释记 public/ 与 binary dist 为已知限制。无缺口。
2. **占位符扫描**:模板里的 `{{ESBUILD_BROWSER_JS}}` 是同步脚本的替换标记(功能所需),非计划占位符;无 TBD/TODO;所有代码步骤含完整代码;命令含预期输出。
3. **类型一致性**:`BuilderMsg`/`HostMsg` 在 T3 定义、T5 编排、T6 胶水三处形状一致(fetched 的中间语义在 T3 契约注释与 T5 规则 4、T6 胶水实现三处吻合);`BuilderIo` 五方法 T5 定义与 T7 ioExpo 实现一致;`createBuildSession` 返回 `{handleBuilderMessage, cancelled}` 与 T7 调用一致;`normalizeImport("index.html", "/src/main.tsx")` → `"src/main.tsx"`(T1 规则:`/` 开头相对根)与 T5 测试期望一致。
4. **真机正确性修正(定稿前)**:RN 侧一切 http 相对解析禁用 `new URL(path, base)`(Hermes polyfill 相对基址不可靠,vitest 能过真机会 throw)——T2 增 `joinHttpUrl` 纯字符串实现(带测试),T5 的 resolve http-importer 分支与 `pkgNameFromUrl` 均已去 URL 化。
