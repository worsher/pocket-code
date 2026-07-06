import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import {
  proxyToLocalhost, type TunnelFrame,
  openLocalWebSocket, onWsTunnelData, onWsTunnelClose, closeAllWsTunnels, clampCloseCode,
} from "./tunnel.js";

let server: Server;
let port: number;

beforeEach(async () => {
  server = createServer((req, res) => {
    if (req.url === "/hello") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hello tunnel");
    } else if (req.url === "/echo" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(201, { "content-type": "text/plain" });
        res.end("got:" + body);
      });
    } else {
      res.writeHead(404);
      res.end("nope");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterEach(() => {
  server.close();
});

function collect(frames: TunnelFrame[]) {
  return (f: TunnelFrame) => frames.push(f);
}

describe("proxyToLocalhost", () => {
  it("proxies a GET and emits response + chunk(s) + end", async () => {
    const frames: TunnelFrame[] = [];
    await proxyToLocalhost(
      { tunnelId: "t1", port, method: "GET", path: "/hello", headers: {} },
      collect(frames)
    );
    const resp = frames.find((f) => f.type === "tunnel-response") as any;
    expect(resp.status).toBe(200);
    const body = frames
      .filter((f) => f.type === "tunnel-chunk")
      .map((f: any) => Buffer.from(f.data, "base64").toString("utf-8"))
      .join("");
    expect(body).toBe("hello tunnel");
    expect(frames[frames.length - 1].type).toBe("tunnel-end");
    expect((frames[frames.length - 1] as any).error).toBeUndefined();
  });

  it("forwards a POST body (base64) and gets the echoed response", async () => {
    const frames: TunnelFrame[] = [];
    await proxyToLocalhost(
      {
        tunnelId: "t2",
        port,
        method: "POST",
        path: "/echo",
        headers: { "content-type": "text/plain" },
        body: Buffer.from("ping").toString("base64"),
      },
      collect(frames)
    );
    const resp = frames.find((f) => f.type === "tunnel-response") as any;
    expect(resp.status).toBe(201);
    const body = frames
      .filter((f) => f.type === "tunnel-chunk")
      .map((f: any) => Buffer.from(f.data, "base64").toString("utf-8"))
      .join("");
    expect(body).toBe("got:ping");
  });

  it("emits tunnel-end with error when the upstream is unreachable", async () => {
    const frames: TunnelFrame[] = [];
    // 关掉 server,端口不可达
    server.close();
    await new Promise((r) => setTimeout(r, 50));
    await proxyToLocalhost(
      { tunnelId: "t3", port, method: "GET", path: "/hello", headers: {} },
      collect(frames)
    );
    const end = frames.find((f) => f.type === "tunnel-end") as any;
    expect(end).toBeDefined();
    expect(end.error).toBeTruthy();
  });
});

/** 起一个本地回显 ws server,返回 { port, wss, close } */
function startEchoServer(): Promise<{ port: number; wss: WebSocketServer; close: () => void }> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 }, () => {
      const addr = wss.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ port, wss, close: () => wss.close() });
    });
    wss.on("connection", (ws) => {
      ws.on("message", (data: Buffer, isBinary: boolean) => ws.send(data, { binary: isBinary }));
    });
  });
}

function collectFrames() {
  const frames: any[] = [];
  const waiters: Array<{ pred: (f: any) => boolean; resolve: (f: any) => void }> = [];
  const emit = (f: any) => {
    frames.push(f);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(f)) waiters.splice(i, 1)[0].resolve(f);
    }
  };
  const waitFor = (pred: (f: any) => boolean, ms = 3000) =>
    new Promise<any>((resolve, reject) => {
      const hit = frames.find(pred);
      if (hit) return resolve(hit);
      waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error("waitFor timeout")), ms);
    });
  return { frames, emit, waitFor };
}

describe("proxyToLocalhost header filtering", () => {
  it("strips hop-by-hop request headers (connection/upgrade/host) before fetch", async () => {
    const { createServer } = await import("http");
    const seen: Record<string, unknown> = {};
    const srv = createServer((rq, rs) => {
      Object.assign(seen, rq.headers);
      rs.writeHead(200, { "content-type": "text/plain" });
      rs.end("ok");
    });
    await new Promise<void>((r) => srv.listen(0, () => r()));
    const port = (srv.address() as any).port;
    const frames: any[] = [];
    await proxyToLocalhost(
      {
        tunnelId: "h1", port, method: "GET", path: "/",
        headers: { host: "evil.example", connection: "upgrade", upgrade: "websocket", cookie: "a=1", "user-agent": "ua" },
      },
      (f) => frames.push(f)
    );
    srv.close();
    expect(frames[0]).toMatchObject({ type: "tunnel-response", status: 200 });
    expect(frames.at(-1).error).toBeUndefined();
    expect(seen["connection"]).not.toBe("upgrade"); // 逐跳头被剥
    expect(seen["upgrade"]).toBeUndefined();
    expect(String(seen["host"])).toContain("localhost"); // host 由 fetch 重置
    expect(seen["cookie"]).toBe("a=1");                  // 业务头保留
  });
});

describe("WS tunnel (daemon side)", () => {
  it("opens local ws, emits opened, round-trips text and binary", async () => {
    const srv = await startEchoServer();
    const { frames, emit, waitFor } = collectFrames();
    try {
      openLocalWebSocket({ tunnelId: "ws_t1", port: srv.port, path: "/", headers: {} }, emit);
      await waitFor((f) => f.type === "tunnel-ws-opened" && f.tunnelId === "ws_t1");

      onWsTunnelData("ws_t1", "hello"); // 文本:回显回来应是文本帧
      const echoText = await waitFor((f) => f.type === "tunnel-ws-data" && f.data === "hello");
      expect(echoText.binary).toBeUndefined();

      onWsTunnelData("ws_t1", Buffer.from([1, 2, 3]).toString("base64"), true);
      const echoBin = await waitFor((f) => f.type === "tunnel-ws-data" && f.binary === true);
      expect(Buffer.from(echoBin.data, "base64")).toEqual(Buffer.from([1, 2, 3]));

      // relay 主动关闭:本地连接关闭且不回发 close 帧(先删后关,防回环)
      onWsTunnelClose("ws_t1", 1000, "bye");
      await new Promise<void>((resolve, reject) => {
        const t0 = Date.now();
        const iv = setInterval(() => {
          if (srv.wss.clients.size === 0) { clearInterval(iv); resolve(); }
          else if (Date.now() - t0 > 3000) { clearInterval(iv); reject(new Error("server client not closed")); }
        }, 10);
      });
      await new Promise((r) => setTimeout(r, 50)); // 留出误发帧的窗口
      expect(frames.some((f: any) => f.type === "tunnel-ws-close")).toBe(false);
    } finally {
      srv.close();
    }
  });

  it("emits tunnel-ws-close when local server closes the socket", async () => {
    const srv = await startEchoServer();
    const { emit, waitFor } = collectFrames();
    openLocalWebSocket({ tunnelId: "ws_t2", port: srv.port, path: "/", headers: {} }, emit);
    await waitFor((f) => f.type === "tunnel-ws-opened");
    srv.wss.clients.forEach((c) => c.close(1001, "going away"));
    const closeFrame = await waitFor((f) => f.type === "tunnel-ws-close" && f.tunnelId === "ws_t2");
    expect(closeFrame.code).toBe(1001);
    srv.close();
  });

  it("emits tunnel-ws-close (not throw) when target port has no server", async () => {
    const { emit, waitFor } = collectFrames();
    openLocalWebSocket({ tunnelId: "ws_t3", port: 1, path: "/", headers: {} }, emit);
    await waitFor((f) => f.type === "tunnel-ws-close" && f.tunnelId === "ws_t3");
  });

  it("closeAllWsTunnels terminates every open tunnel", async () => {
    const srv = await startEchoServer();
    const { emit, waitFor } = collectFrames();
    openLocalWebSocket({ tunnelId: "ws_t4", port: srv.port, path: "/", headers: {} }, emit);
    await waitFor((f) => f.type === "tunnel-ws-opened");
    closeAllWsTunnels();
    // 之后向该隧道写数据应为 no-op(不抛)
    expect(() => onWsTunnelData("ws_t4", "x")).not.toThrow();
    srv.close();
  });

  it("clampCloseCode passes legal codes and falls back to 1000", () => {
    expect(clampCloseCode(1000)).toBe(1000);
    expect(clampCloseCode(1001)).toBe(1001);
    expect(clampCloseCode(1011)).toBe(1011);
    expect(clampCloseCode(4321)).toBe(4321);
    expect(clampCloseCode(1006)).toBe(1000); // 保留码不可主动发送
    expect(clampCloseCode(undefined)).toBe(1000);
    expect(clampCloseCode(99)).toBe(1000);
  });

  it("onWsTunnelClose deletes the tunnel entry immediately (repeat call is a no-op)", async () => {
    const srv = await startEchoServer();
    const { emit, waitFor } = collectFrames();
    openLocalWebSocket({ tunnelId: "ws_t5", port: srv.port, path: "/", headers: {} }, emit);
    await waitFor((f) => f.type === "tunnel-ws-opened");
    onWsTunnelClose("ws_t5", 1000);
    expect(() => onWsTunnelClose("ws_t5", 1000)).not.toThrow(); // 条目已删,直接 return
    expect(() => onWsTunnelData("ws_t5", "x")).not.toThrow();
    srv.close();
  });
});
