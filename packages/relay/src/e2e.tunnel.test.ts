// ── E2E:relay(子进程) + tunnel-client(进程内) 反向隧道穿透 ──
// 证明"不装 daemon 也能做隧道代理"。依赖 tsx(relay devDep)拉起 src/index.ts。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { createServer, request as httpRequest, type Server } from "http";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import WebSocket from "ws";
import { startTunnelClient, type TunnelClientHandle } from "@pocket-code/tunnel-client";

const here = dirname(fileURLToPath(import.meta.url));
const SECRET = "e2e-secret";
const TOKEN = "tok-e2e";

function randPort(): number {
  return 20000 + Math.floor(Math.random() * 20000);
}

async function waitHealthy(port: number, ms = 15000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() - t0 > ms) throw new Error(`relay :${port} not healthy in ${ms}ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function waitMachines(port: number, n: number, ms = 10000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const j = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    if (j.machines >= n) return;
    if (Date.now() - t0 > ms) throw new Error(`machines<${n} after ${ms}ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function spawnRelay(env: Record<string, string>): ChildProcess {
  const tsxBin = join(here, "..", "node_modules", ".bin", "tsx");
  const child = spawn(tsxBin, [join(here, "index.ts")], {
    env: { ...process.env, ...env },
    stdio: "ignore",
  });
  return child;
}

/**
 * 用 Node 原生 http.request 发起请求(仅供需要自定义 Host 头的子域寻址测试使用)——
 * fetch()/undici 把 Host 当禁止头处理,静默丢弃覆盖(始终发实际连接 host),
 * 子域场景必须真正改变 Host 才能验证路由,故绕过 fetch 走底层 http.request。
 * 镜像 httpRouter.test.ts 的同名 helper。
 */
function requestWithHost(port: number, path: string, headers: Record<string, string>): Promise<{
  status: number;
  text: () => Promise<string>;
}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c as Buffer));
      res.on("end", () => {
        resolve({
          status: res.statusCode || 0,
          text: async () => Buffer.concat(chunks).toString("utf-8"),
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function startTarget(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`hello-tunnel:${req.url}`);
    });
    server.listen(0, () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0 });
    });
  });
}

describe("E2E: relay + tunnel-client 反向隧道", () => {
  describe("场景A: DISCOVERY=off,无 TUNNEL_TOKEN", () => {
    const relayPort = randPort();
    let relay: ChildProcess;
    let target: { server: Server; port: number };
    let client: TunnelClientHandle;

    beforeAll(async () => {
      relay = spawnRelay({ PORT: String(relayPort), RELAY_SECRET: SECRET, RELAY_DISCOVERY: "off", TUNNEL_TOKEN: "", TUNNEL_MODE: "path" });
      await waitHealthy(relayPort);
      target = await startTarget();
      client = startTunnelClient({
        relayUrl: `ws://127.0.0.1:${relayPort}/relay`,
        relaySecret: SECRET,
        machineId: "e2eaaa1",
        machineName: "e2e-a",
      });
      await waitMachines(relayPort, 1);
    }, 30000);

    afterAll(() => {
      client?.stop();
      target?.server.close();
      relay?.kill();
    });

    it("HTTP 经隧道穿透取回目标响应(含 query)", async () => {
      const resp = await fetch(`http://127.0.0.1:${relayPort}/t/e2eaaa1/${target.port}/hello?x=1`);
      expect(resp.status).toBe(200);
      expect(await resp.text()).toBe("hello-tunnel:/hello?x=1");
    }, 15000);

    it("DISCOVERY off:list-machines 被拒", async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/relay`);
      const reply = await new Promise<any>((resolve, reject) => {
        ws.on("open", () => ws.send(JSON.stringify({ type: "list-machines" })));
        ws.on("message", (d: Buffer) => resolve(JSON.parse(d.toString())));
        ws.on("error", reject);
        setTimeout(() => reject(new Error("no reply")), 5000);
      });
      ws.close();
      expect(reply).toEqual({ type: "error", error: "Discovery is disabled on this relay" });
    }, 10000);
  });

  describe("场景B: TUNNEL_TOKEN 开启", () => {
    const relayPort = randPort();
    let relay: ChildProcess;
    let target: { server: Server; port: number };
    let client: TunnelClientHandle;

    beforeAll(async () => {
      relay = spawnRelay({ PORT: String(relayPort), RELAY_SECRET: SECRET, TUNNEL_TOKEN: TOKEN, RELAY_DISCOVERY: "", TUNNEL_MODE: "path" });
      await waitHealthy(relayPort);
      target = await startTarget();
      client = startTunnelClient({
        relayUrl: `ws://127.0.0.1:${relayPort}/relay`,
        relaySecret: SECRET,
        machineId: "e2ebbb2",
        machineName: "e2e-b",
      });
      await waitMachines(relayPort, 1);
    }, 30000);

    afterAll(() => {
      client?.stop();
      target?.server.close();
      relay?.kill();
    });

    it("无 token → 404;带 pc_token → 200 且种 pc_tunnel_token cookie", async () => {
      const denied = await fetch(`http://127.0.0.1:${relayPort}/t/e2ebbb2/${target.port}/`);
      expect(denied.status).toBe(404);

      const ok = await fetch(`http://127.0.0.1:${relayPort}/t/e2ebbb2/${target.port}/?pc_token=${TOKEN}`);
      expect(ok.status).toBe(200);
      expect(await ok.text()).toBe("hello-tunnel:/");
      expect(ok.headers.getSetCookie().join(";;")).toContain(`pc_tunnel_token=${TOKEN}`);
    }, 15000);

    it("cookie 路径:合法 token cookie 通过,错误 token 404", async () => {
      const ok = await fetch(`http://127.0.0.1:${relayPort}/sub.js`, {
        headers: { cookie: `pc_tunnel=e2ebbb2:${target.port}; pc_tunnel_token=${TOKEN}` },
      });
      expect(ok.status).toBe(200);
      expect(await ok.text()).toBe("hello-tunnel:/sub.js");

      const bad = await fetch(`http://127.0.0.1:${relayPort}/sub.js`, {
        headers: { cookie: `pc_tunnel=e2ebbb2:${target.port}; pc_tunnel_token=wrong` },
      });
      expect(bad.status).toBe(404);
    }, 15000);
  });

  describe("场景C: 子域模式(TUNNEL_MODE=subdomain)", () => {
    const relayPort = randPort();
    const BASE = "tunnel.localhost";
    const MID = "aa11bb22cc33dd44";
    let relay: ChildProcess;
    let target: { server: Server; port: number };
    let client: TunnelClientHandle;

    beforeAll(async () => {
      relay = spawnRelay({
        PORT: String(relayPort), RELAY_SECRET: SECRET,
        RELAY_DISCOVERY: "off", TUNNEL_TOKEN: "",
        TUNNEL_MODE: "subdomain", TUNNEL_BASE_DOMAIN: BASE,
      });
      await waitHealthy(relayPort);
      target = await startTarget();
      client = startTunnelClient({
        relayUrl: `ws://127.0.0.1:${relayPort}/relay`,
        relaySecret: SECRET, machineId: MID, machineName: "e2e-c",
      });
      await waitMachines(relayPort, 1);
    }, 30000);

    afterAll(() => { client?.stop(); target?.server.close(); relay?.kill(); });

    it("/health 报告 subdomain 模式 + baseDomain", async () => {
      const j = await (await fetch(`http://127.0.0.1:${relayPort}/health`)).json();
      expect(j.tunnelMode).toBe("subdomain");
      expect(j.tunnelBaseDomain).toBe(BASE);
    }, 10000);

    it("Host 驱动路由:<id>-<port>.<base> 经隧道取回目标响应", async () => {
      // relay 从 Host 解析目标;path 直达根,forwardPath=/hello
      const resp = await requestWithHost(relayPort, `/hello?x=1`, {
        host: `${MID}-${target.port}.${BASE}`,
      });
      expect(resp.status).toBe(200);
      expect(await resp.text()).toBe("hello-tunnel:/hello?x=1");
    }, 15000);

    it("主站 Host + 非 /health 路径 → 404(非隧道)", async () => {
      const resp = await requestWithHost(relayPort, "/whatever", { host: BASE });
      expect(resp.status).toBe(404);
    }, 10000);
  });
});
