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

// 行为差异注记(与旧 server 版 path.resolve 语义):rel 传入绝对路径时,
// 本实现拼接为 workspace 内相对路径(如 "/etc/x" → "<ws>/etc/x",安全),
// 旧版会以绝对路径覆盖 base 并被 startsWith 拒绝。两者均不可越权,
// 但"哪些输入被拒绝"不同——迁移调用方若依赖拒绝行为需注意。
export function safePath(workspace: string, relativePath: string): string {
  const ws = resolvePosix(workspace, ".");
  const full = resolvePosix(ws, relativePath);
  if (full !== ws && !full.startsWith(ws + "/")) {
    throw new Error("Path traversal not allowed");
  }
  return full;
}
