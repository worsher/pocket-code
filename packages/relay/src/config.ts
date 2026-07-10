// ── Relay 配置与注册鉴权 ────────────────────────────────────
// P6a:RELAY_SECRET 从可选改为必填(fail-fast);HMAC 验证抽成可测函数,
// 并修复原实现 timingSafeEqual 在长度不等时抛异常的问题。

import crypto from "crypto";

/** 取 RELAY_SECRET,未设置/空白则抛错(启动 fail-fast)。 */
export function requireRelaySecret(
  env: Record<string, string | undefined> = process.env
): string {
  const secret = (env.RELAY_SECRET || "").trim();
  if (!secret) {
    throw new Error(
      "RELAY_SECRET 未设置。生成:openssl rand -hex 32 ;" +
        "relay 与所有 daemon 必须配置同一个值:export RELAY_SECRET=<value>"
    );
  }
  return secret;
}

/** 注册时间窗(防重放) */
export const HMAC_TIME_WINDOW_MS = 5 * 60 * 1000;

/** 校验 daemon 注册的 HMAC-SHA256(machineId + timestamp, secret)。 */
export function verifyDaemonAuth(
  secret: string,
  machineId: string,
  timestamp: number | undefined,
  authToken: string | undefined,
  now: number = Date.now()
): { ok: true } | { ok: false; error: string } {
  if (!authToken || !timestamp) {
    return { ok: false, error: "Registration requires authToken and timestamp." };
  }
  if (Math.abs(now - timestamp) > HMAC_TIME_WINDOW_MS) {
    return { ok: false, error: "Registration timestamp expired. Check system clock sync." };
  }
  const expected = crypto
    .createHmac("sha256", secret)
    .update(machineId + timestamp)
    .digest("hex");
  const given = Buffer.from(authToken, "hex");
  const want = Buffer.from(expected, "hex");
  // timingSafeEqual 要求等长;长度不等必不匹配,先比长度避免抛异常
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    return { ok: false, error: "Invalid authToken. RELAY_SECRET mismatch." };
  }
  return { ok: true };
}

/** RELAY_DISCOVERY=off 时关闭发现与配对转发(纯隧道部署姿态);默认 on。 */
export function isDiscoveryEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return (env.RELAY_DISCOVERY || "on").trim().toLowerCase() !== "off";
}

/** TUNNEL_TOKEN:trim 后非空才启用隧道入口鉴权;否则 null(现状:machineId 即能力凭证)。 */
export function getTunnelToken(
  env: Record<string, string | undefined> = process.env
): string | null {
  const t = (env.TUNNEL_TOKEN || "").trim();
  return t || null;
}

/** 常量时间比较隧道 token(等长前置短路,同 verifyDaemonAuth 手法)。 */
export function verifyTunnelToken(expected: string, given: string | null | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** pc_tunnel_token cookie 是否附加 Secure(默认 on;VPS 裸 IP/纯 http 部署设 off,否则浏览器拒存)。 */
export function isTunnelCookieSecure(
  env: Record<string, string | undefined> = process.env
): boolean {
  return (env.TUNNEL_COOKIE_SECURE || "on").trim().toLowerCase() !== "off";
}

/** 隧道寻址模式:子域(默认)或路径前缀。 */
export type TunnelMode = "subdomain" | "path";

/** TUNNEL_MODE:默认 subdomain,仅显式 "path" 切换(同 isDiscoveryEnabled 风格)。 */
export function getTunnelMode(
  env: Record<string, string | undefined> = process.env
): TunnelMode {
  return (env.TUNNEL_MODE || "").trim().toLowerCase() === "path" ? "path" : "subdomain";
}

/** TUNNEL_BASE_DOMAIN:子域模式必需(如 "tunnel.aigc.zj.cn");trim 后空 → null。 */
export function getTunnelBaseDomain(
  env: Record<string, string | undefined> = process.env
): string | null {
  const d = (env.TUNNEL_BASE_DOMAIN || "").trim();
  return d || null;
}
