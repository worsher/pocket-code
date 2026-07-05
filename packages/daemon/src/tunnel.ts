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

export type TunnelFrame =
  | { type: "tunnel-response"; tunnelId: string; status: number; headers: Record<string, string> }
  | { type: "tunnel-chunk"; tunnelId: string; data: string }
  | { type: "tunnel-end"; tunnelId: string; error?: string };

export async function proxyToLocalhost(
  req: TunnelHttpRequest,
  emit: (frame: TunnelFrame) => void,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const url = `http://127.0.0.1:${req.port}${req.path}`;
  try {
    const init: RequestInit = { method: req.method, headers: req.headers };
    if (req.body !== undefined && req.method !== "GET" && req.method !== "HEAD") {
      init.body = Buffer.from(req.body, "base64");
    }
    const resp = await fetchImpl(url, init);

    const headers: Record<string, string> = {};
    resp.headers.forEach((v, k) => {
      headers[k] = v;
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
/** tunnelId → 对应的 emit 函数 */
const wsEmits = new Map<string, (frame: unknown) => void>();

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
  const headers: Record<string, string> = { origin: `http://127.0.0.1:${req.port}` };
  if (req.headers["cookie"]) headers["cookie"] = req.headers["cookie"];
  if (req.headers["user-agent"]) headers["user-agent"] = req.headers["user-agent"];

  const ws = new WebSocket(`ws://127.0.0.1:${req.port}${req.path}`, protocols, { headers });
  wsTunnels.set(req.tunnelId, ws);
  wsEmits.set(req.tunnelId, emit);

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
    if (wsTunnels.delete(req.tunnelId)) {
      wsEmits.delete(req.tunnelId);
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
    console.warn(`[Daemon] WS tunnel ${req.tunnelId} error: ${err.message}`);
  });
}

/** relay 来的浏览器侧数据 → 本地 ws */
export function onWsTunnelData(tunnelId: string, data: string, binary?: boolean): void {
  const ws = wsTunnels.get(tunnelId);
  if (!ws) return;
  if (ws.readyState !== WebSocket.OPEN) {
    console.warn(`[Daemon] Dropped ws-tunnel data for ${tunnelId} (state=${ws.readyState})`);
    return;
  }
  ws.send(binary ? Buffer.from(data, "base64") : data);
}

/** relay 来的关闭指令(浏览器侧已关) */
export function onWsTunnelClose(tunnelId: string, code?: number, reason?: string): void {
  const ws = wsTunnels.get(tunnelId);
  if (!ws) return;
  wsTunnels.delete(tunnelId);
  const emit = wsEmits.get(tunnelId);
  wsEmits.delete(tunnelId);
  try {
    ws.close(clampCloseCode(code), reason);
  } catch {
    ws.terminate();
  }
  // 发送 close 帧,避免依赖异步 close 事件的时序
  if (emit) {
    emit({
      type: "tunnel-ws-close",
      tunnelId,
      code: clampCloseCode(code),
      reason: reason ? reason.slice(0, 512) : undefined,
    });
  }
}

/** relay 断连时全部关闭(浏览器侧已不可达) */
export function closeAllWsTunnels(): void {
  for (const [, ws] of wsTunnels) {
    try { ws.terminate(); } catch { /* ignore */ }
  }
  wsTunnels.clear();
  wsEmits.clear();
}
