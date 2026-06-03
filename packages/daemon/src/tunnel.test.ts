import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { proxyToLocalhost, type TunnelFrame } from "./tunnel.js";

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
