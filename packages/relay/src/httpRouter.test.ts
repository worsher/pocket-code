import { describe, it, expect, afterEach } from "vitest";
import { createServer, request as httpRequest, type Server } from "http";
import { createHttpHandler } from "./httpRouter.js";
import { TunnelHub } from "./tunnelHub.js";

interface Ctx { server: Server; port: number; hub: TunnelHub; frames: any[]; }

async function startHttp(
  tunnelToken: string | null,
  tunnelCookieSecure = true,
  tunnelMode: "subdomain" | "path" = "path",
  tunnelBaseDomain: string | null = null
): Promise<Ctx> {
  const hub = new TunnelHub();
  const frames: any[] = [];
  const server = createServer(
    createHttpHandler({
      tunnelHub: hub,
      sendToDaemon: (machineId, frame) => { frames.push({ machineId, frame }); return true; },
      getOnlineMachineCount: () => 1,
      port: 0,
      tunnelToken,
      tunnelCookieSecure,
      tunnelMode,
      tunnelBaseDomain,
    })
  );
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  return { server, hub, frames, port: typeof addr === "object" && addr ? addr.port : 0 };
}

const ctxs: Ctx[] = [];
afterEach(() => { for (const c of ctxs.splice(0)) c.server.close(); });

/**
 * 用 Node 原生 http.request 发起请求,返回一个提供 status/text()/headers.getSetCookie()
 * 的 fetch-Response 兼容外壳。仅供 fetchViaTunnel 在需要自定义 Host 头时使用——
 * fetch()/undici 把 Host 当禁止头处理,静默丢弃覆盖(始终发实际连接 host),
 * 子域寻址测试必须真正改变 Host 才能验证路由,故绕过 fetch 走底层 http.request。
 */
function requestWithHost(port: number, path: string, headers: Record<string, string>): Promise<{
  status: number;
  text: () => Promise<string>;
  headers: { getSetCookie: () => string[] };
}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c as Buffer));
      res.on("end", () => {
        const rawSetCookie = res.headers["set-cookie"] || [];
        resolve({
          status: res.statusCode || 0,
          text: async () => Buffer.concat(chunks).toString("utf-8"),
          headers: { getSetCookie: () => rawSetCookie },
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/** 发起隧道请求并用 hub 以 owner 身份回帧,拿到完整响应 */
async function fetchViaTunnel(ctx: Ctx, path: string, headers: Record<string, string> = {}) {
  // host 头驱动子域寻址:fetch 无法覆盖 Host(undici 禁止头),改走底层 http.request。
  const respP = headers.host
    ? requestWithHost(ctx.port, path, headers)
    : fetch(`http://127.0.0.1:${ctx.port}${path}`, { headers, redirect: "manual" });
  // 等待 tunnel-request 帧到达(鉴权失败时不会到达)
  const t0 = Date.now();
  while (!ctx.frames.length && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 10));
  if (ctx.frames.length) {
    const { machineId, frame } = ctx.frames[0];
    ctx.hub.onResponse(frame.tunnelId, 200, { "content-type": "text/plain" }, machineId);
    ctx.hub.onChunk(frame.tunnelId, Buffer.from(`echo:${frame.path}`).toString("base64"), machineId);
    ctx.hub.onEnd(frame.tunnelId, undefined, machineId);
  }
  return respP;
}

describe("createHttpHandler", () => {
  it("health 正常返回", async () => {
    const ctx = await startHttp(null); ctxs.push(ctx);
    const resp = await fetch(`http://127.0.0.1:${ctx.port}/health`);
    expect(resp.status).toBe(200);
    expect((await resp.json()).machines).toBe(1);
  });

  it("token 关闭时 /t/ 路径直通并种 pc_tunnel cookie(现状不变)", async () => {
    const ctx = await startHttp(null); ctxs.push(ctx);
    const resp = await fetchViaTunnel(ctx, "/t/m_1/5173/hello?x=1");
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("echo:/hello?x=1");
    expect(resp.headers.getSetCookie().join(";")).toContain("pc_tunnel=m_1:5173");
    expect(ctx.frames[0].frame.path).toBe("/hello?x=1");
  });

  it("token 开启:无 token 404 且不转发", async () => {
    const ctx = await startHttp("tok"); ctxs.push(ctx);
    const resp = await fetch(`http://127.0.0.1:${ctx.port}/t/m_1/5173/`);
    expect(resp.status).toBe(404);
    expect(ctx.frames).toHaveLength(0);
  });

  it("token 开启:pc_token 查询参数通过,种 HttpOnly cookie,且 token 不进转发 path", async () => {
    const ctx = await startHttp("tok"); ctxs.push(ctx);
    const resp = await fetchViaTunnel(ctx, "/t/m_1/5173/hello?pc_token=tok&x=1");
    expect(resp.status).toBe(200);
    const cookies = resp.headers.getSetCookie().join(";;");
    expect(cookies).toContain("pc_tunnel=m_1:5173");
    expect(cookies).toContain("pc_tunnel_token=tok");
    expect(cookies).toContain("HttpOnly");
    expect(ctx.frames[0].frame.path).toBe("/hello?x=1"); // pc_token 已剥除
  });

  it("token 开启:cookie 路径带合法 pc_tunnel_token 通过,错误 token 404", async () => {
    const ctx = await startHttp("tok"); ctxs.push(ctx);
    const ok = await fetchViaTunnel(ctx, "/sub.js", { cookie: "pc_tunnel=m_1:5173; pc_tunnel_token=tok" });
    expect(ok.status).toBe(200);
    expect(ctx.frames[0].frame.path).toBe("/sub.js");

    const ctx2 = await startHttp("tok"); ctxs.push(ctx2);
    const bad = await fetch(`http://127.0.0.1:${ctx2.port}/sub.js`, {
      headers: { cookie: "pc_tunnel=m_1:5173; pc_tunnel_token=wrong" },
    });
    expect(bad.status).toBe(404);
    expect(ctx2.frames).toHaveLength(0);
  });

  it("token 开启:Secure 默认附加在 pc_tunnel_token cookie(路由 cookie pc_tunnel 不受影响)", async () => {
    const ctx = await startHttp("tok"); ctxs.push(ctx);
    const resp = await fetchViaTunnel(ctx, "/t/m_1/5173/?pc_token=tok");
    const cookies = resp.headers.getSetCookie();
    const tokenCookie = cookies.find((c) => c.startsWith("pc_tunnel_token="));
    expect(tokenCookie).toContain("; Secure");
    const routeCookie = cookies.find((c) => c.startsWith("pc_tunnel="));
    expect(routeCookie).not.toContain("Secure");
  });

  it("TUNNEL_COOKIE_SECURE=off:pc_tunnel_token 不带 Secure(VPS 裸 IP/纯 http 部署)", async () => {
    const ctx = await startHttp("tok", false); ctxs.push(ctx);
    const resp = await fetchViaTunnel(ctx, "/t/m_1/5173/?pc_token=tok");
    const tokenCookie = resp.headers.getSetCookie().find((c) => c.startsWith("pc_tunnel_token="));
    expect(tokenCookie).toBeDefined();
    expect(tokenCookie).not.toContain("Secure");
  });

  it("/health 暴露 tunnelMode + tunnelBaseDomain", async () => {
    const ctx = await startHttp(null, true, "subdomain", "tunnel.aigc.zj.cn"); ctxs.push(ctx);
    const j = await (await fetch(`http://127.0.0.1:${ctx.port}/health`)).json();
    expect(j.tunnelMode).toBe("subdomain");
    expect(j.tunnelBaseDomain).toBe("tunnel.aigc.zj.cn");
  });

  it("subdomain 模式:Host 驱动路由,forwardPath=pathname,不下发 pc_tunnel", async () => {
    const ctx = await startHttp(null, true, "subdomain", "tunnel.aigc.zj.cn"); ctxs.push(ctx);
    const resp = await fetchViaTunnel(ctx, "/admin", { host: "bda488cfdee21ccc-3000.tunnel.aigc.zj.cn" });
    expect(resp.status).toBe(200);
    expect(ctx.frames[0].frame.path).toBe("/admin");
    expect(ctx.frames[0].machineId).toBe("bda488cfdee21ccc");
    expect(resp.headers.getSetCookie().join(";")).not.toContain("pc_tunnel="); // 子域不下发
  });

  it("subdomain 模式:主站 Host → 隧道不触发(无 tunnel-request 帧)", async () => {
    const ctx = await startHttp(null, true, "subdomain", "tunnel.aigc.zj.cn"); ctxs.push(ctx);
    const resp = await fetch(`http://127.0.0.1:${ctx.port}/whatever`, { headers: { host: "aigc.zj.cn" } });
    expect(resp.status).toBe(404); // control→非 /health→非隧道→404
    expect(ctx.frames).toHaveLength(0);
  });

  it("path 模式:3xx Location 被补前缀,Set-Cookie(pc_tunnel)不被改写", async () => {
    const ctx = await startHttp(null, true, "path"); ctxs.push(ctx);
    // 手动驱动一次隧道,用 hub 回一个 307+Location + 一条应用 Set-Cookie
    const respP = fetch(`http://127.0.0.1:${ctx.port}/t/bda488cfdee21ccc/3000/`, { redirect: "manual" });
    const t0 = Date.now();
    while (!ctx.frames.length && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 10));
    const { machineId, frame } = ctx.frames[0];
    ctx.hub.onResponse(frame.tunnelId, 307, { location: "/admin", "set-cookie": "app=1; Path=/" }, machineId);
    ctx.hub.onEnd(frame.tunnelId, undefined, machineId);
    const resp = await respP;
    expect(resp.status).toBe(307);
    expect(resp.headers.get("location")).toBe("/t/bda488cfdee21ccc/3000/admin");
    // pc_tunnel 路由 cookie 仍 Path=/(下发点),应用 cookie 原样
    const setc = resp.headers.getSetCookie().join(";;");
    expect(setc).toContain("pc_tunnel=bda488cfdee21ccc:3000; Path=/");
    expect(setc).toContain("app=1; Path=/");
  });
});
