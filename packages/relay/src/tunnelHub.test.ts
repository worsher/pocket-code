import { describe, it, expect, vi } from "vitest";
import { ServerResponse, IncomingMessage } from "http";
import { Socket } from "net";
import { TunnelHub } from "./tunnelHub.js";

function mockRes() {
  return {
    writeHead: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
  } as any;
}

describe("TunnelHub", () => {
  it("writes response head, chunks, and ends to the registered res", () => {
    const hub = new TunnelHub();
    const res = mockRes();
    hub.open("t1", res, "m_A");
    hub.onResponse("t1", 200, { "content-type": "text/html", "transfer-encoding": "chunked" });
    hub.onChunk("t1", Buffer.from("hi").toString("base64"));
    hub.onEnd("t1");

    // 状态码写入,且过滤了 transfer-encoding 这类逐跳头
    expect(res.writeHead).toHaveBeenCalledTimes(1);
    const [status, headers] = res.writeHead.mock.calls[0];
    expect(status).toBe(200);
    expect(headers["content-type"]).toBe("text/html");
    expect(headers["transfer-encoding"]).toBeUndefined();
    expect(Buffer.from(res.write.mock.calls[0][0]).toString("utf-8")).toBe("hi");
    expect(res.end).toHaveBeenCalled();
    expect(hub.size).toBe(0); // end 后清理
  });

  it("injects extraHeaders (e.g. Set-Cookie) into the response head", () => {
    const hub = new TunnelHub();
    const res = mockRes();
    hub.open("t1", res, "m_A", { "Set-Cookie": "pc_tunnel=m_abc:5173; Path=/" });
    hub.onResponse("t1", 200, { "content-type": "text/html" });
    const [, headers] = res.writeHead.mock.calls[0];
    expect(headers["content-type"]).toBe("text/html");
    expect(headers["Set-Cookie"]).toBe("pc_tunnel=m_abc:5173; Path=/");
  });

  it("ignores frames for unknown tunnelId", () => {
    const hub = new TunnelHub();
    expect(() => hub.onChunk("nope", "YWJj")).not.toThrow();
    expect(() => hub.onEnd("nope")).not.toThrow();
  });

  it("on error end without prior response writes a 502", () => {
    const hub = new TunnelHub();
    const res = mockRes();
    hub.open("t2", res, "m_A");
    hub.onEnd("t2", "upstream down");
    expect(res.writeHead).toHaveBeenCalledWith(502);
    expect(res.end).toHaveBeenCalled();
  });

  it("abortAll ends all pending tunnels", () => {
    const hub = new TunnelHub();
    const r1 = mockRes();
    const r2 = mockRes();
    hub.open("a", r1, "m_A");
    hub.open("b", r2, "m_A");
    hub.abortAll();
    expect(r1.end).toHaveBeenCalled();
    expect(r2.end).toHaveBeenCalled();
    expect(hub.size).toBe(0);
  });

  it("drops frames whose senderMachineId does not own the tunnel (防伪造)", () => {
    const hub = new TunnelHub();
    const res = mockRes();
    hub.open("t1", res, "m_A");
    hub.onResponse("t1", 200, {}, "m_B");
    hub.onChunk("t1", Buffer.from("x").toString("base64"), "m_B");
    hub.onEnd("t1", undefined, "m_B");
    expect(res.writeHead).not.toHaveBeenCalled();
    expect(res.write).not.toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
    expect(hub.size).toBe(1); // 仍挂起,未被恶意 end
    // 正主来了照常工作
    hub.onResponse("t1", 200, {}, "m_A");
    hub.onEnd("t1", undefined, "m_A");
    expect(res.end).toHaveBeenCalled();
  });

  it("abortByMachine only ends that machine's tunnels", () => {
    const hub = new TunnelHub();
    const rA = mockRes();
    const rB = mockRes();
    hub.open("tA", rA, "m_A");
    hub.open("tB", rB, "m_B");
    hub.abortByMachine("m_A");
    expect(rA.end).toHaveBeenCalled();
    expect(rB.end).not.toHaveBeenCalled();
    expect(hub.size).toBe(1);
  });
});

function fakeRes() {
  const res = new ServerResponse(new IncomingMessage(new Socket()));
  const captured: { status?: number; headers?: any } = {};
  (res as any).writeHead = (s: number, h: any) => { captured.status = s; captured.headers = h; return res; };
  (res as any).write = () => true;
  (res as any).end = () => res;
  return { res, captured };
}

describe("TunnelHub.onResponse rewrite 回调", () => {
  it("open 传入 rewriteHeaders 时,onResponse 用它改写后再 writeHead", () => {
    const hub = new TunnelHub();
    const { res, captured } = fakeRes();
    hub.open("t1", res, "m1", undefined, (h) => ({ ...h, location: "/t/m1/3000" + (h.location ?? "") }));
    hub.onResponse("t1", 307, { location: "/admin" }, "m1");
    expect(captured.status).toBe(307);
    expect(captured.headers.location).toBe("/t/m1/3000/admin");
  });
  it("无 rewriteHeaders 时 onResponse 原样写头(现状回归)", () => {
    const hub = new TunnelHub();
    const { res, captured } = fakeRes();
    hub.open("t2", res, "m1");
    hub.onResponse("t2", 200, { "content-type": "text/plain" }, "m1");
    expect(captured.status).toBe(200);
    expect(captured.headers["content-type"]).toBe("text/plain");
  });
});
