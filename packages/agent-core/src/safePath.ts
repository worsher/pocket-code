// ── 工作区路径防穿越(同构:不依赖 node:path) ─────────────────
// 迁自 server tools.ts,并修 sibling 前缀绕过(/ws 匹配 /ws-evil)。

/** 极简 posix resolve:拼接后规范化 ".."/"."。仅处理 "/" 分隔(两端 workspace 均为 posix 风格)。 */
function resolvePosix(base: string, rel: string): string {
  const segs = (base + "/" + rel).split("/");
  const out: string[] = [];
  for (const s of segs) {
    if (!s || s === ".") continue;
    if (s === "..") out.pop();
    else out.push(s);
  }
  return "/" + out.join("/");
}

export function safePath(workspace: string, relativePath: string): string {
  const ws = resolvePosix(workspace, ".");
  const full = resolvePosix(ws, relativePath);
  if (full !== ws && !full.startsWith(ws + "/")) {
    throw new Error("Path traversal not allowed");
  }
  return full;
}
