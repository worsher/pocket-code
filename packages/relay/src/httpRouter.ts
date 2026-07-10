// ── HTTP 入口(健康检查 + 反向隧道路由),从 index.ts 抽出可测 ──
// TUNNEL_TOKEN 设置时,隧道入口(显式 /t/ 与 pc_tunnel cookie 路径)强制鉴权:
// 首次 ?pc_token=<v> 校验通过后种 pc_tunnel_token HttpOnly cookie;失败一律 404。

import crypto from "crypto";
import type { IncomingMessage, ServerResponse } from "http";
import type { TunnelHub } from "./tunnelHub.js";
import { verifyTunnelToken } from "./config.js";

export interface HttpRouterDeps {
  tunnelHub: TunnelHub;
  sendToDaemon: (machineId: string, frame: unknown) => boolean;
  getOnlineMachineCount: () => number;
  port: number;
  /** null=不启用隧道入口鉴权(默认,与现状一致) */
  tunnelToken: string | null;
  /** pc_tunnel_token cookie 是否附加 Secure(TUNNEL_COOKIE_SECURE,默认 true;裸 IP/纯 http 部署关) */
  tunnelCookieSecure: boolean;
}

const TUNNEL_TOKEN_COOKIE_RE = /(?:^|;\s*)pc_tunnel_token=([^;]+)/;
const TUNNEL_COOKIE_RE = /(?:^|;\s*)pc_tunnel=([^:;]+):(\d+)/;

export function createHttpHandler(deps: HttpRouterDeps) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    res.setHeader("Access-Control-Allow-Origin", "*");

    const url = new URL(req.url || "", `http://localhost:${deps.port || 80}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          timestamp: Date.now(),
          machines: deps.getOnlineMachineCount(),
        })
      );
      return;
    }

    const notFound = () => {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not Found" }));
    };

    // ── 隧道入口鉴权(TUNNEL_TOKEN 未设置时恒通过) ──
    const queryToken = url.searchParams.get("pc_token");
    const cookieToken = ((req.headers.cookie || "").match(TUNNEL_TOKEN_COOKIE_RE) || [])[1];
    const tokenOk =
      deps.tunnelToken === null ||
      verifyTunnelToken(deps.tunnelToken, queryToken) ||
      verifyTunnelToken(deps.tunnelToken, cookieToken);

    // pc_token 只用于鉴权,不进转发 path(避免污染目标服务的请求)
    url.searchParams.delete("pc_token");
    const search = url.searchParams.toString() ? `?${url.searchParams.toString()}` : "";

    // 启动一条隧道:收齐请求体后转给 daemon。
    const startTunnel = (
      machineId: string,
      port: number,
      path: string,
      extraHeaders?: Record<string, string | string[]>
    ) => {
      const tunnelId = crypto.randomUUID();
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers[k] = v;
        else if (Array.isArray(v)) headers[k] = v.join(", ");
      }
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        const body = chunks.length ? Buffer.concat(chunks).toString("base64") : undefined;
        deps.tunnelHub.open(tunnelId, res, machineId, extraHeaders);
        const ok = deps.sendToDaemon(machineId, {
          type: "tunnel-request",
          tunnelId,
          port,
          method: req.method || "GET",
          path,
          headers,
          body,
        });
        if (!ok) deps.tunnelHub.onEnd(tunnelId, `daemon ${machineId} offline`);
      });
    };

    // ── 显式隧道: /t/<machineId>/<port>/<rest> ──
    // 顺便下发 pc_tunnel cookie,使该页的「绝对路径子资源」(如 vite 的 /src/x)
    // 也能被路由回同一隧道(否则绝对路径会丢掉 /t/<id>/<port> 前缀而 404)。
    const tunnelMatch = url.pathname.match(/^\/t\/([^/]+)\/(\d+)(\/.*)?$/);
    if (tunnelMatch) {
      if (!tokenOk) return notFound();
      const [, machineId, portStr, rest] = tunnelMatch;
      const port = parseInt(portStr, 10);
      const setCookies = [`pc_tunnel=${machineId}:${port}; Path=/; SameSite=Lax`];
      if (deps.tunnelToken !== null && queryToken && verifyTunnelToken(deps.tunnelToken, queryToken)) {
        // Secure 防明文 http 泄漏 token;裸 IP/纯 http 部署经 TUNNEL_COOKIE_SECURE=off 关闭(否则浏览器拒存)
        const secure = deps.tunnelCookieSecure ? "; Secure" : "";
        setCookies.push(`pc_tunnel_token=${queryToken}; Path=/; HttpOnly; SameSite=Lax${secure}`);
      }
      startTunnel(machineId, port, (rest || "/") + search, { "Set-Cookie": setCookies });
      return;
    }

    // ── 绝对路径子资源:靠 pc_tunnel cookie 路由回同一隧道 ──
    const cookieMatch = (req.headers.cookie || "").match(TUNNEL_COOKIE_RE);
    if (cookieMatch) {
      if (!tokenOk) return notFound();
      startTunnel(cookieMatch[1], parseInt(cookieMatch[2], 10), url.pathname + search);
      return;
    }

    notFound();
  };
}
