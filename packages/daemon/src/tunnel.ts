// ── daemon 反向代理(隧道接收端) ─────────────────────────────
// 收 relay 来的 tunnel-request,请求开发机 localhost:<port>,把响应
// 切成 tunnel-response + tunnel-chunk(base64) + tunnel-end 帧回传。

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
