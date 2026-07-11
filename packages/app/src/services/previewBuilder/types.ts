// builder WebView ↔ RN 的 bridge 协议(单一 JSON 信封)。
// 校验入站(builder→RN)消息形状;出站 HostMsg 由 TS 类型约束。
//
// 协议语义(给 T5/T6 的共同契约): 一个 `load{id}` 可能先收到 `fetch{id,url}` 指令(builder 去 `fetch(url)` 后回 `fetched{id,...}`),再收到最终 `loaded{id,...}` —— builder 的 pending 表以 `resolved`/`loaded` 为终结。`loaded.binary === true` 时 `contents` 为 base64,builder 侧转 Uint8Array 交 esbuild。取消 = RN 直接卸载 WebView,无协议消息。

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
