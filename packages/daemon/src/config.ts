// ── Daemon 配置守卫 ─────────────────────────────────────────
// P6a:relay 强制注册鉴权后,daemon 无 RELAY_SECRET 注册必被拒,
// 与其静默重试刷屏,不如启动即失败并给出指引。

export function requireRelaySecret(
  env: Record<string, string | undefined> = process.env
): string {
  const secret = (env.RELAY_SECRET || "").trim();
  if (!secret) {
    throw new Error(
      "RELAY_SECRET 未设置。生成:openssl rand -hex 32 ;" +
        "必须与 relay 配置同一个值:export RELAY_SECRET=<value>"
    );
  }
  return secret;
}
