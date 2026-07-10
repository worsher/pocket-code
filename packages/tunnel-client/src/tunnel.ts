// ── daemon 反向代理(隧道接收端) ─────────────────────────────
// 收 relay 来的 tunnel-request,请求开发机 localhost:<port>,把响应
// 切成 tunnel-response + tunnel-chunk(base64) + tunnel-end 帧回传。

import { WebSocket } from "ws";

export interface TunnelHttpRequest {
  tunnelId: string;
  port: number;
  method: string;
  path: string;
  headers: Record<string, string>;
  /** base64 请求体(GET/HEAD 无)。 */
  body?: string;
}

export type HttpReplyFrame =
  | { type: "tunnel-response"; tunnelId: string; status: number; headers: Record<string, string> }
  | { type: "tunnel-chunk"; tunnelId: string; data: string }
  | { type: "tunnel-end"; tunnelId: string; error?: string };

// 请求侧逐跳/连接管理头:不可透传给 fetch。
// connection/upgrade 来自反代(nginx 常无条件设 Connection:upgrade),undici 会直接抛错;
// host 透传会触发 vite 5+ 的 allowedHosts 拦截,fetch 自会按目标 URL 重置。
const REQ_HOP_BY_HOP = new Set([
  "host", "connection", "upgrade", "keep-alive",
  "transfer-encoding", "content-length", "proxy-connection", "te", "trailer",
]);

export async function proxyToLocalhost(
  req: TunnelHttpRequest,
  emit: (frame: HttpReplyFrame) => void,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  // localhost 而非 127.0.0.1:dev server 可能只绑 IPv6 ::1(macOS 常见),
  // Node>=20 对 localhost 自动双栈选族(Happy Eyeballs),v4/v6 都能连上。
  const url = `http://localhost:${req.port}${req.path}`;
  try {
    const reqHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!REQ_HOP_BY_HOP.has(k.toLowerCase())) reqHeaders[k] = v;
    }
    const init: RequestInit = { method: req.method, headers: reqHeaders };
    if (req.body !== undefined && req.method !== "GET" && req.method !== "HEAD") {
      init.body = Buffer.from(req.body, "base64");
    }
    const resp = await fetchImpl(url, init);

    // fetch(undici) 已自动解压 body,但 headers 仍保留压缩响应的
    // content-encoding/content-length——原样转发会让浏览器按 gzip 解码明文
    // (ERR_CONTENT_DECODING_FAILED)。体已变,头必须跟着变。
    const RESP_STRIP = new Set(["content-encoding", "content-length"]);
    const headers: Record<string, string> = {};
    resp.headers.forEach((v, k) => {
      if (!RESP_STRIP.has(k.toLowerCase())) headers[k] = v;
    });
    emit({ type: "tunnel-response", tunnelId: req.tunnelId, status: resp.status, headers });

    if (resp.body) {
      const reader = resp.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length) {
          emit({
            type: "tunnel-chunk",
            tunnelId: req.tunnelId,
            data: Buffer.from(value).toString("base64"),
          });
        }
      }
    }
    emit({ type: "tunnel-end", tunnelId: req.tunnelId });
  } catch (err: any) {
    emit({ type: "tunnel-end", tunnelId: req.tunnelId, error: err?.message ?? "tunnel proxy failed" });
  }
}

// ── WS 隧道(P7 HMR):relay 的 tunnel-ws-* 帧 ↔ 本地 dev server 的 WebSocket ──

export interface TunnelWsOpenRequest {
  tunnelId: string;
  port: number;
  path: string;
  headers: Record<string, string>;
}

/** tunnelId → 本地 ws 连接 */
const wsTunnels = new Map<string, WebSocket>();

/** ws.close() 只接受合法关闭码;帧里的原始码在调用前夹紧。 */
export function clampCloseCode(code?: number): number {
  if (code === 1000 || code === 1001 || code === 1011 || (code !== undefined && code >= 3000 && code <= 4999)) {
    return code;
  }
  return 1000;
}

export function openLocalWebSocket(
  req: TunnelWsOpenRequest,
  emit: (frame: unknown) => void
): void {
  const protocols = (req.headers["sec-websocket-protocol"] || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const headers: Record<string, string> = { origin: `http://localhost:${req.port}` };
  if (req.headers["cookie"]) headers["cookie"] = req.headers["cookie"];
  if (req.headers["user-agent"]) headers["user-agent"] = req.headers["user-agent"];

  // 同 proxyToLocalhost:localhost 双栈,兼容只绑 ::1 的 dev server
  const ws = new WebSocket(`ws://localhost:${req.port}${req.path}`, protocols, { headers });
  wsTunnels.set(req.tunnelId, ws);

  ws.on("open", () => {
    emit({ type: "tunnel-ws-opened", tunnelId: req.tunnelId, protocol: ws.protocol || undefined });
  });
  ws.on("message", (data: Buffer, isBinary: boolean) => {
    emit(
      isBinary
        ? { type: "tunnel-ws-data", tunnelId: req.tunnelId, data: data.toString("base64"), binary: true }
        : { type: "tunnel-ws-data", tunnelId: req.tunnelId, data: data.toString("utf-8") }
    );
  });
  ws.on("close", (code: number, reason: Buffer) => {
    // relay 主动关闭(onWsTunnelClose 已先删条目)时 delete 返回 false → 不回发,防回环帧
    if (wsTunnels.delete(req.tunnelId)) {
      emit({
        type: "tunnel-ws-close",
        tunnelId: req.tunnelId,
        code,
        reason: reason.toString("utf-8").slice(0, 512) || undefined,
      });
    }
  });
  ws.on("error", (err: Error) => {
    // 连接失败时 'close' 会随后触发(1006)并发 close 帧;这里只记日志
    // AggregateError(双栈 ECONNREFUSED 等)的 message 为空,需展开子错误
    const detail =
      err.message ||
      (err instanceof AggregateError && err.errors.map((e: any) => e?.message ?? String(e)).join("; ")) ||
      String(err);
    console.warn(`[Tunnel] WS tunnel ${req.tunnelId} (localhost:${req.port}${req.path}) error: ${detail}`);
  });
}

/** relay 来的浏览器侧数据 → 本地 ws */
export function onWsTunnelData(tunnelId: string, data: string, binary?: boolean): void {
  const ws = wsTunnels.get(tunnelId);
  if (!ws) return;
  if (ws.readyState !== WebSocket.OPEN) {
    console.warn(`[Tunnel] Dropped ws-tunnel data for ${tunnelId} (state=${ws.readyState})`);
    return;
  }
  ws.send(binary ? Buffer.from(data, "base64") : data);
}

/** relay 来的关闭指令(浏览器侧已关):先删后关,不回发 close 帧(防回环) */
export function onWsTunnelClose(tunnelId: string, code?: number, reason?: string): void {
  const ws = wsTunnels.get(tunnelId);
  if (!ws) return;
  wsTunnels.delete(tunnelId);
  try {
    ws.close(clampCloseCode(code), reason);
  } catch {
    ws.terminate();
  }
}

/** relay 断连时全部关闭(浏览器侧已不可达) */
export function closeAllWsTunnels(): void {
  for (const [, ws] of wsTunnels) {
    try { ws.terminate(); } catch { /* ignore */ }
  }
  wsTunnels.clear();
}
