// ── 路径模式:补 Location 前缀 ──────────────────────────────
// 仅当 Location 是"站内绝对路径"(/ 开头、非 //、非 scheme://)时补 /t/<id>/<port>
// 前缀,让服务端 3xx 重定向不掉出隧道前缀。绝不改写任何 Set-Cookie
// (pc_tunnel 需保持 Path=/ 兜底裸绝对路径子资源)。子域模式不调用本函数。

/** 站内绝对路径:/ 开头,但不是 //host(protocol-relative)。 */
function isSiteAbsolute(loc: string): boolean {
  return loc.startsWith("/") && !loc.startsWith("//");
}

export function rewriteRedirectHeaders(
  headers: Record<string, string | string[]>,
  machineId: string,
  port: number
): Record<string, string | string[]> {
  const prefix = `/t/${machineId}/${port}`;
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "location" && typeof v === "string" && isSiteAbsolute(v)) {
      out[k] = prefix + v;
    } else {
      out[k] = v;
    }
  }
  return out;
}
