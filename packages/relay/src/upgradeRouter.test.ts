import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { createUpgradeHandler, makeTunnelWss } from "./upgradeRouter.js";
import { WsTunnelHub } from "./wsTunnelHub.js";

interface Ctx {
  server: Server;
  port: number;
  hub: WsTunnelHub;
  daemonFrames: any[];
  controlConnections: number;
}

async function startRelay(
  tunnelToken: string | null = null,
  tunnelMode: "subdomain" | "path" = "path",
  tunnelBaseDomain: string | null = null
): Promise<Ctx> {
  const daemonFrames: any[] = [];
  const hub = new WsTunnelHub((machineId, frame) => {
    daemonFrames.push({ machineId, frame });
    return true;
  });
  const controlWss = new WebSocketServer({ noServer: true });
  const ctx: Partial<Ctx> = { daemonFrames, hub, controlConnections: 0 };
  controlWss.on("connection", () => { ctx.controlConnections!++; });
  const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  server.on("upgrade", createUpgradeHandler({
    controlWss,
    tunnelWss: makeTunnelWss(),
    wsTunnelHub: hub,
    sendToDaemon: (m, f) => { daemonFrames.push({ machineId: m, frame: f }); return true; },
    port: 0,
    tunnelToken,
    tunnelMode,
    tunnelBaseDomain,
  }));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  ctx.server = server;
  ctx.port = typeof addr === "object" && addr ? addr.port : 0;
  return ctx as Ctx;
}

const ctxs: Ctx[] = [];
afterEach(() => { for (const c of ctxs.splice(0)) c.server.close(); });

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((res, rej) => { ws.on("open", () => res()); ws.on("error", rej); });
}
function until(pred: () => boolean, ms = 3000): Promise<void> {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (pred()) { clearInterval(iv); res(); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error("until timeout")); }
    }, 10);
  });
}

describe("upgrade routing", () => {
  it("routes /t/<machineId>/<port>/<path> upgrades to the ws tunnel", async () => {
    const ctx = await startRelay(); ctxs.push(ctx);
    const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/t/m_X/5173/hmr`);
    await waitOpen(ws);
    await until(() => ctx.daemonFrames.some((d) => d.frame.type === "tunnel-ws-open"));
    const open = ctx.daemonFrames.find((d) => d.frame.type === "tunnel-ws-open");
    expect(open.machineId).toBe("m_X");
    expect(open.frame.port).toBe(5173);
    expect(open.frame.path).toBe("/hmr");
    expect(ctx.controlConnections).toBe(0);
    ws.close();
  });

  it("routes cookie-bearing upgrades (vite connects to /) to the ws tunnel", async () => {
    const ctx = await startRelay(); ctxs.push(ctx);
    const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/`, {
      headers: { cookie: "pc_tunnel=m_Y:3000" },
    });
    await waitOpen(ws);
    await until(() => ctx.daemonFrames.some((d) => d.frame.type === "tunnel-ws-open"));
    const open = ctx.daemonFrames.find((d) => d.frame.type === "tunnel-ws-open");
    expect(open.machineId).toBe("m_Y");
    expect(open.frame.port).toBe(3000);
    expect(open.frame.path).toBe("/");
    ws.close();
  });

  it("routes /relay upgrades to the control channel even when a tunnel cookie exists", async () => {
    const ctx = await startRelay(); ctxs.push(ctx);
    const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/relay`, {
      headers: { cookie: "pc_tunnel=m_Y:3000" },
    });
    await waitOpen(ws);
    await until(() => ctx.controlConnections === 1);
    expect(ctx.daemonFrames).toHaveLength(0);
    ws.close();
  });

  it("routes /relay/ (trailing slash) upgrades to the control channel even when a tunnel cookie exists", async () => {
    const ctx = await startRelay(); ctxs.push(ctx);
    const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/relay/`, {
      headers: { cookie: "pc_tunnel=m_Y:3000" },
    });
    await waitOpen(ws);
    await until(() => ctx.controlConnections === 1);
    expect(ctx.daemonFrames).toHaveLength(0);
    ws.close();
  });

  it("routes plain upgrades to the control channel", async () => {
    const ctx = await startRelay(); ctxs.push(ctx);
    const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/`);
    await waitOpen(ws);
    await until(() => ctx.controlConnections === 1);
    expect(ctx.daemonFrames).toHaveLength(0);
    ws.close();
  });

  it("full round trip: browser msg buffered, flushed after opened, daemon data reaches browser", async () => {
    const ctx = await startRelay(); ctxs.push(ctx);
    const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/t/m_Z/5173/`);
    const received: string[] = [];
    ws.on("message", (d: Buffer) => received.push(d.toString()));
    await waitOpen(ws);
    ws.send("hello-from-browser");
    await until(() => ctx.daemonFrames.some((d) => d.frame.type === "tunnel-ws-open"));
    const tunnelId = ctx.daemonFrames.find((d) => d.frame.type === "tunnel-ws-open").frame.tunnelId;

    // opened 前浏览器消息不应直发
    expect(ctx.daemonFrames.some((d) => d.frame.type === "tunnel-ws-data")).toBe(false);
    ctx.hub.onOpened(tunnelId, "m_Z"); // 模拟 daemon 确认
    await until(() => ctx.daemonFrames.some((d) => d.frame.type === "tunnel-ws-data"));
    expect(ctx.daemonFrames.find((d) => d.frame.type === "tunnel-ws-data").frame.data).toBe("hello-from-browser");

    ctx.hub.onData(tunnelId, "hmr-update", undefined, "m_Z"); // 模拟 daemon 回数据
    await until(() => received.includes("hmr-update"));
    ws.close();
  });

  it("echoes the first requested subprotocol (vite-hmr)", async () => {
    const ctx = await startRelay(); ctxs.push(ctx);
    const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/t/m_P/5173/`, ["vite-hmr"]);
    await waitOpen(ws);
    expect(ws.protocol).toBe("vite-hmr");
    ws.close();
  });

  it("TUNNEL_TOKEN 开启:无 token 的隧道 upgrade 被 404 拒绝", async () => {
    const ctx = await startRelay("tok"); ctxs.push(ctx);
    const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/t/m_X/5173/hmr`);
    await new Promise<void>((res) => ws.on("error", () => res()));
    expect(ctx.daemonFrames).toHaveLength(0);
  });

  it("TUNNEL_TOKEN 开启:pc_token 查询参数通过且不进转发 path;控制通道不受影响", async () => {
    const ctx = await startRelay("tok"); ctxs.push(ctx);
    const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/t/m_X/5173/hmr?pc_token=tok&y=2`);
    await waitOpen(ws);
    await until(() => ctx.daemonFrames.some((d) => d.frame.type === "tunnel-ws-open"));
    const open = ctx.daemonFrames.find((d) => d.frame.type === "tunnel-ws-open");
    expect(open.frame.path).toBe("/hmr?y=2");
    ws.close();

    const ctrl = new WebSocket(`ws://127.0.0.1:${ctx.port}/relay`);
    await waitOpen(ctrl);
    await until(() => ctx.controlConnections === 1);
    ctrl.close();
  });

  it("TUNNEL_TOKEN 开启:pc_tunnel_token cookie 通过", async () => {
    const ctx = await startRelay("tok"); ctxs.push(ctx);
    const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/`, {
      headers: { cookie: "pc_tunnel=m_Y:3000; pc_tunnel_token=tok" },
    });
    await waitOpen(ws);
    await until(() => ctx.daemonFrames.some((d) => d.frame.type === "tunnel-ws-open"));
    ws.close();
  });
});

// ── 两模式寻址判定(是否落到 tunnel/control) ──────────────
// 与上面的 startRelay 套件(转发细节/鉴权)不同,这里只关心 dispatchUpgrade
// 把请求分到哪个 wss——起一个挂了 createUpgradeHandler 的 http server,
// 用两个 controlWss/tunnelWss 各自 connection 事件计数,发起 ws 握手断言落到哪个 wss。

interface ModeCtx { server: Server; port: number; controlHits: string[]; tunnelHits: number; }
const modeCtxs: ModeCtx[] = [];
afterEach(() => { for (const c of modeCtxs.splice(0)) c.server.close(); });

async function startWs(mode: "subdomain" | "path", baseDomain: string | null): Promise<ModeCtx> {
  const controlWss = new WebSocketServer({ noServer: true });
  const tunnelWss = makeTunnelWss();
  const ctx: ModeCtx = { server: null as any, port: 0, controlHits: [], tunnelHits: 0 };
  controlWss.on("connection", (_ws, req) => ctx.controlHits.push(req.url || ""));
  const wsTunnelHub = new WsTunnelHub(() => true); // sendToDaemon 恒真,open 后不真正连
  tunnelWss.on("connection", () => { ctx.tunnelHits++; });
  const server = createServer();
  server.on("upgrade", createUpgradeHandler({
    controlWss, tunnelWss, wsTunnelHub,
    sendToDaemon: () => true, port: 0,
    tunnelToken: null, tunnelMode: mode, tunnelBaseDomain: baseDomain,
  }));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  ctx.server = server; ctx.port = typeof addr === "object" && addr ? addr.port : 0;
  return ctx;
}

function tryWs(port: number, path: string, host?: string): Promise<void> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, host ? { headers: { host } } : {});
    ws.on("open", () => { ws.close(); resolve(); });
    ws.on("error", () => resolve()); // 404/destroy 也算完成
    setTimeout(resolve, 800);
  });
}

describe("createUpgradeHandler 寻址(两模式)", () => {
  it("path 模式:/relay → control", async () => {
    const ctx = await startWs("path", null); modeCtxs.push(ctx);
    await tryWs(ctx.port, "/relay");
    expect(ctx.controlHits.some((u) => u.startsWith("/relay"))).toBe(true);
  });
  it("path 模式:/t/abc123/5173/ → tunnel", async () => {
    const ctx = await startWs("path", null); modeCtxs.push(ctx);
    await tryWs(ctx.port, "/t/abc123/5173/");
    expect(ctx.tunnelHits).toBe(1);
  });
  it("subdomain 模式:隧道子域 Host → tunnel", async () => {
    const ctx = await startWs("subdomain", "tunnel.aigc.zj.cn"); modeCtxs.push(ctx);
    await tryWs(ctx.port, "/", "aa11bb22-5173.tunnel.aigc.zj.cn");
    expect(ctx.tunnelHits).toBe(1);
  });
  it("subdomain 模式:控制 Host(主站)+ /relay → control", async () => {
    const ctx = await startWs("subdomain", "tunnel.aigc.zj.cn"); modeCtxs.push(ctx);
    await tryWs(ctx.port, "/relay", "aigc.zj.cn");
    expect(ctx.controlHits.some((u) => u.startsWith("/relay"))).toBe(true);
  });
});
