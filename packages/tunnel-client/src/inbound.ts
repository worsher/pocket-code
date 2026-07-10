// ── relay 入站消息解析(safeParse 边界) ───────────────────────
// P6a:daemon 只接受 wire DaemonInbound 联合内的消息,畸形消息丢弃+日志。

import { DaemonInbound, type DaemonInboundType } from "@pocket-code/protocol-core";

export function parseRelayMessage(raw: string): DaemonInboundType | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    console.warn("[Tunnel] Dropped non-JSON relay message");
    return null;
  }
  const parsed = DaemonInbound.safeParse(json);
  if (!parsed.success) {
    const t = (json as Record<string, unknown> | null)?.type;
    console.warn(`[Tunnel] Dropped invalid relay message (type=${String(t)})`);
    return null;
  }
  return parsed.data;
}
