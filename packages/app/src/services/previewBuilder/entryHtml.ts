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
