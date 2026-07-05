// ── 隧道枢纽(relay 侧) ──────────────────────────────────────
// 关联 http 请求(ServerResponse)与 tunnelId:把 daemon 回来的
// tunnel-response/chunk/end 帧写进对应的 HTTP 响应。

import type { ServerResponse } from "http";

interface PendingTunnel {
  res: ServerResponse;
  responded: boolean;
  /** 该隧道归属的 daemon(P6a:回帧必须来自它) */
  machineId: string;
  /** relay 侧注入的附加响应头(如 Set-Cookie 记忆隧道目标)。 */
  extraHeaders?: Record<string, string>;
}

// 逐跳头:不应原样透传(我们用 write/end 隐式 chunked)。
const HOP_BY_HOP = new Set(["transfer-encoding", "connection", "content-length", "keep-alive"]);

export class TunnelHub {
  private tunnels = new Map<string, PendingTunnel>();

  open(
    tunnelId: string,
    res: ServerResponse,
    machineId: string,
    extraHeaders?: Record<string, string>
  ): void {
    this.tunnels.set(tunnelId, { res, responded: false, machineId, extraHeaders });
  }

  /** 归属校验:senderMachineId 传入且与归属不符 → 返回 undefined(丢弃)。 */
  private owned(tunnelId: string, senderMachineId?: string): PendingTunnel | undefined {
    const t = this.tunnels.get(tunnelId);
    if (!t) return undefined;
    if (senderMachineId !== undefined && t.machineId !== senderMachineId) {
      console.warn(
        `[Relay] Dropped tunnel frame for ${tunnelId} from non-owner ${senderMachineId}`
      );
      return undefined;
    }
    return t;
  }

  onResponse(tunnelId: string, status: number, headers: Record<string, string>, senderMachineId?: string): void {
    const t = this.owned(tunnelId, senderMachineId);
    if (!t || t.responded) return;
    t.responded = true;
    const safe: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase())) safe[k] = v;
    }
    // 注入 relay 附加头(如下发 pc_tunnel cookie,使绝对路径子资源也能路由回本隧道)。
    if (t.extraHeaders) Object.assign(safe, t.extraHeaders);
    try {
      t.res.writeHead(status, safe);
    } catch {
      /* res 已结束/出错,忽略 */
    }
  }

  onChunk(tunnelId: string, dataBase64: string, senderMachineId?: string): void {
    const t = this.owned(tunnelId, senderMachineId);
    if (!t) return;
    try {
      t.res.write(Buffer.from(dataBase64, "base64"));
    } catch {
      /* ignore */
    }
  }

  onEnd(tunnelId: string, error?: string, senderMachineId?: string): void {
    const t = this.owned(tunnelId, senderMachineId);
    if (!t) return;
    this.tunnels.delete(tunnelId);
    try {
      if (!t.responded && error) {
        t.res.writeHead(502);
      }
      t.res.end();
    } catch {
      /* ignore */
    }
  }

  /** 中止某台 daemon 的全部挂起隧道(该 daemon 掉线时)。 */
  abortByMachine(machineId: string, error = "daemon offline"): void {
    for (const [id, t] of this.tunnels) {
      if (t.machineId === machineId) this.onEnd(id, error);
    }
  }

  /** 中止所有挂起隧道(如 daemon 断线时)。 */
  abortAll(error = "tunnel closed"): void {
    for (const [id] of this.tunnels) this.onEnd(id, error);
  }

  get size(): number {
    return this.tunnels.size;
  }
}
