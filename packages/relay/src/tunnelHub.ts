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
  extraHeaders?: Record<string, string | string[]>;
  /** 路径模式:写响应头前对头做补前缀改写(子域模式不传)。 */
  rewriteHeaders?: (h: Record<string, string | string[]>) => Record<string, string | string[]>;
}

// 逐跳头:不应原样透传(我们用 write/end 隐式 chunked)。
const HOP_BY_HOP = new Set(["transfer-encoding", "connection", "content-length", "keep-alive"]);

/**
 * 大小写不敏感地把 extra 合并进 target(就地改)。
 * 若 target 已有同名(忽略大小写)键,合并成数组挂在已存在的原键名下,
 * 不新增第二个大小写变体键——Node 的 res.writeHead 在该 res 之前调用过
 * setHeader() 时,对"同一 header 名的两个不同大小写键"处理有缺陷(其一被丢弃)。
 * 详见 tunnelHub.test.ts。仅在真撞键时才合并,否则原样赋值(不改变类型/大小写)。
 */
function mergeHeadersCaseInsensitive(
  target: Record<string, string | string[]>,
  extra: Record<string, string | string[]>
): void {
  for (const [k, v] of Object.entries(extra)) {
    const existingKey = Object.keys(target).find((tk) => tk.toLowerCase() === k.toLowerCase());
    if (existingKey === undefined) {
      target[k] = v;
    } else {
      const existing = target[existingKey];
      target[existingKey] = [...(Array.isArray(existing) ? existing : [existing]), ...(Array.isArray(v) ? v : [v])];
    }
  }
}

export class TunnelHub {
  private tunnels = new Map<string, PendingTunnel>();

  open(
    tunnelId: string,
    res: ServerResponse,
    machineId: string,
    extraHeaders?: Record<string, string | string[]>,
    rewriteHeaders?: (h: Record<string, string | string[]>) => Record<string, string | string[]>
  ): void {
    this.tunnels.set(tunnelId, { res, responded: false, machineId, extraHeaders, rewriteHeaders });
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
    const safe: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase())) safe[k] = v;
    }
    // 注入 relay 附加头(如下发 pc_tunnel cookie,使绝对路径子资源也能路由回本隧道)。
    if (t.extraHeaders) mergeHeadersCaseInsensitive(safe, t.extraHeaders);
    // 路径模式:补 Location 前缀(子域模式 rewriteHeaders 为空,跳过)。
    const finalHeaders = t.rewriteHeaders ? t.rewriteHeaders(safe) : safe;
    try {
      t.res.writeHead(status, finalHeaders);
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
