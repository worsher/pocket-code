import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "http";
import { createHttpHandler } from "./httpRouter.js";
import { TunnelHub } from "./tunnelHub.js";

interface Ctx { server: Server; port: number; hub: TunnelHub; frames: any[]; }

async function startHttp(tunnelToken: string | null, tunnelCookieSecure = true): Promise<Ctx> {
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
    })
  );
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  return { server, hub, frames, port: typeof addr === "object" && addr ? addr.port : 0 };
}

const ctxs: Ctx[] = [];
afterEach(() => { for (const c of ctxs.splice(0)) c.server.close(); });

/** 发起隧道请求并用 hub 以 owner 身份回帧,拿到完整响应 */
async function fetchViaTunnel(ctx: Ctx, path: string, headers: Record<string, string> = {}) {
  const respP = fetch(`http://127.0.0.1:${ctx.port}${path}`, { headers, redirect: "manual" });
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
});
