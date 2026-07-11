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
