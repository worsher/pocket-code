// ── 隧道寻址:从请求解析出目标 machineId+port(两 router 唯一决策点) ──
// 子域模式从 Host 解析 <machineId>-<port>.<baseDomain>;路径模式从 /t/ 前缀
// 或 pc_tunnel cookie 解析。纯函数:不做 pc_token 剥离/query 拼接/鉴权(调用方负责)。

import type { TunnelMode } from "./config.js";

export interface TunnelTarget {
  machineId: string;
  port: number;
  /** 转发给 daemon 的 path(不含 query)。子域=原样 pathname;路径=剥前缀后的 rest。 */
  forwardPath: string;
}

export type ResolveResult =
  | { kind: "tunnel"; target: TunnelTarget }
  | { kind: "control" } // 非隧道请求(控制通道 /relay,或子域模式的主站/非匹配 Host)
  | { kind: "none" };   // 既非隧道也非控制(HTTP 该 404)

const PATH_TUNNEL_RE = /^\/t\/([^/]+)\/(\d+)(\/.*)?$/;
const PATH_COOKIE_RE = /(?:^|;\s*)pc_tunnel=([^:;]+):(\d+)/;
// machineId(hex)-port,后接 .<baseDomain>。machineId 段限 hex 以贴合纯 hex 生成规则。
const SUB_LABEL_RE = /^([0-9a-f]+)-(\d+)$/i;

export function resolveTunnelTarget(
  mode: TunnelMode,
  host: string | undefined,
  pathname: string,
  cookieHeader: string | undefined,
  baseDomain: string | null
): ResolveResult {
  if (mode === "subdomain") {
    if (!host || !baseDomain) return { kind: "control" };
    const hostname = host.split(":")[0]; // 去掉可能的 :port
    const suffix = `.${baseDomain}`;
    if (!hostname.endsWith(suffix)) return { kind: "control" };
    const label = hostname.slice(0, -suffix.length); // <machineId>-<port>
    const m = label.match(SUB_LABEL_RE);
    if (!m) return { kind: "control" };
    return {
      kind: "tunnel",
      target: { machineId: m[1], port: parseInt(m[2], 10), forwardPath: pathname },
    };
  }

  // path 模式
  if (pathname === "/relay" || pathname === "/relay/") return { kind: "control" };
  const pm = pathname.match(PATH_TUNNEL_RE);
  if (pm) {
    return {
      kind: "tunnel",
      target: { machineId: pm[1], port: parseInt(pm[2], 10), forwardPath: pm[3] || "/" },
    };
  }
  const cm = (cookieHeader || "").match(PATH_COOKIE_RE);
  if (cm) {
    return {
      kind: "tunnel",
      target: { machineId: cm[1], port: parseInt(cm[2], 10), forwardPath: pathname },
    };
  }
  return { kind: "none" };
}
