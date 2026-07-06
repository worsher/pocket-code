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

async function startRelay(): Promise<Ctx> {
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
});
