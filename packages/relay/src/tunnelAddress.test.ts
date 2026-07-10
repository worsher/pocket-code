import { describe, it, expect } from "vitest";
import { resolveTunnelTarget } from "./tunnelAddress.js";

const BASE = "tunnel.aigc.zj.cn";

describe("resolveTunnelTarget — subdomain 模式", () => {
  it("合法子域 Host 解析出 machineId+port,forwardPath=pathname", () => {
    const r = resolveTunnelTarget("subdomain", `bda488cfdee21ccc-3000.${BASE}`, "/admin", undefined, BASE);
    expect(r).toEqual({ kind: "tunnel", target: { machineId: "bda488cfdee21ccc", port: 3000, forwardPath: "/admin" } });
  });
  it("Host 带端口后缀(:443)仍能解析(浏览器可能带)", () => {
    const r = resolveTunnelTarget("subdomain", `bda488cfdee21ccc-3000.${BASE}:443`, "/", undefined, BASE);
    expect(r.kind).toBe("tunnel");
    if (r.kind === "tunnel") expect(r.target).toMatchObject({ machineId: "bda488cfdee21ccc", port: 3000 });
  });
  it("baseDomain 本身 → control(非隧道)", () => {
    expect(resolveTunnelTarget("subdomain", BASE, "/relay", undefined, BASE)).toEqual({ kind: "control" });
  });
  it("主站域 / 不匹配 → control", () => {
    expect(resolveTunnelTarget("subdomain", "aigc.zj.cn", "/", undefined, BASE)).toEqual({ kind: "control" });
  });
  it("裸 IP Host → control", () => {
    expect(resolveTunnelTarget("subdomain", "139.196.157.166", "/", undefined, BASE)).toEqual({ kind: "control" });
  });
  it("端口段非数字 → control(不是合法隧道子域)", () => {
    expect(resolveTunnelTarget("subdomain", `bda488cfdee21ccc-abc.${BASE}`, "/", undefined, BASE)).toEqual({ kind: "control" });
  });
  it("baseDomain 为 null(配置缺失)→ control(不 crash)", () => {
    expect(resolveTunnelTarget("subdomain", `x-3000.${BASE}`, "/", undefined, null)).toEqual({ kind: "control" });
  });
  it("Host 缺失 → control", () => {
    expect(resolveTunnelTarget("subdomain", undefined, "/", undefined, BASE)).toEqual({ kind: "control" });
  });
  it("忽略 /t/ 前缀(子域模式不认路径寻址)", () => {
    const r = resolveTunnelTarget("subdomain", `aa11bb22cc33dd44-8080.${BASE}`, "/t/other/9999/x", undefined, BASE);
    expect(r.kind).toBe("tunnel");
    if (r.kind === "tunnel") expect(r.target).toMatchObject({ port: 8080, forwardPath: "/t/other/9999/x" });
  });
});

describe("resolveTunnelTarget — path 模式", () => {
  it("/t/id/port/rest 解析,forwardPath=rest", () => {
    const r = resolveTunnelTarget("path", "aigc.zj.cn", "/t/bda488cfdee21ccc/3000/admin", undefined, null);
    expect(r).toEqual({ kind: "tunnel", target: { machineId: "bda488cfdee21ccc", port: 3000, forwardPath: "/admin" } });
  });
  it("/t/id/port(无尾 rest)→ forwardPath '/'", () => {
    const r = resolveTunnelTarget("path", "h", "/t/abc123/5173", undefined, null);
    expect(r.kind).toBe("tunnel");
    if (r.kind === "tunnel") expect(r.target.forwardPath).toBe("/");
  });
  it("pc_tunnel cookie 兜底,forwardPath=pathname", () => {
    const r = resolveTunnelTarget("path", "h", "/_next/x.js", "pc_tunnel=abc123:5173", null);
    expect(r).toEqual({ kind: "tunnel", target: { machineId: "abc123", port: 5173, forwardPath: "/_next/x.js" } });
  });
  it("/relay 与 /relay/ → control", () => {
    expect(resolveTunnelTarget("path", "h", "/relay", undefined, null)).toEqual({ kind: "control" });
    expect(resolveTunnelTarget("path", "h", "/relay/", undefined, null)).toEqual({ kind: "control" });
  });
  it("无 /t/ 无 cookie → none", () => {
    expect(resolveTunnelTarget("path", "h", "/whatever", undefined, null)).toEqual({ kind: "none" });
  });
  it("忽略 Host 子域(路径模式不认 Host 寻址)", () => {
    const r = resolveTunnelTarget("path", `zzz-1234.${BASE}`, "/t/abc123/3000/", undefined, BASE);
    expect(r.kind).toBe("tunnel");
    if (r.kind === "tunnel") expect(r.target).toMatchObject({ machineId: "abc123", port: 3000 });
  });
});
