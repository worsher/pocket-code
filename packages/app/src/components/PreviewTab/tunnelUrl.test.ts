import { describe, it, expect } from "vitest";
import { buildTunnelUrl, maybeRewriteToTunnel } from "./tunnelUrl.js";

describe("buildTunnelUrl", () => {
  it("默认/path 模式:拼 /t/<id>/<port>/", () => {
    expect(buildTunnelUrl("wss://aigc.zj.cn/relay", "abc123", 3000))
      .toBe("https://aigc.zj.cn/relay/t/abc123/3000/");
  });
  it("path 模式显式:同上", () => {
    expect(buildTunnelUrl("wss://aigc.zj.cn/relay", "abc123", 3000, { mode: "path", baseDomain: null }))
      .toBe("https://aigc.zj.cn/relay/t/abc123/3000/");
  });
  it("subdomain 模式:拼 <id>-<port>.<baseDomain>", () => {
    expect(buildTunnelUrl("wss://aigc.zj.cn/relay", "abc123", 3000, { mode: "subdomain", baseDomain: "tunnel.aigc.zj.cn" }))
      .toBe("https://abc123-3000.tunnel.aigc.zj.cn/");
  });
  it("subdomain 模式缺 baseDomain → 回退 path", () => {
    expect(buildTunnelUrl("ws://h:3200/relay", "abc123", 5173, { mode: "subdomain", baseDomain: null }))
      .toBe("http://h:3200/relay/t/abc123/5173/");
  });
  it("ws→http / wss→https 协议映射", () => {
    expect(buildTunnelUrl("ws://h:3200", "id0", 8080, { mode: "subdomain", baseDomain: "t.example.com" }))
      .toBe("http://id0-8080.t.example.com/");
  });
});

const S = (over: object) => ({ workspaceMode: "relay", relayServerUrl: "wss://aigc.zj.cn/relay", relayMachineId: "abc123", ...over });

describe("maybeRewriteToTunnel", () => {
  it("非 relay 模式返回 null", () => {
    expect(maybeRewriteToTunnel("3000", { workspaceMode: "local" })).toBeNull();
  });
  it("裸端口 → path 隧道 URL", () => {
    expect(maybeRewriteToTunnel("3000", S({}))).toBe("https://aigc.zj.cn/relay/t/abc123/3000/");
  });
  it("裸端口 + subdomain info → 子域 URL", () => {
    expect(maybeRewriteToTunnel("3000", S({ relayTunnelMode: "subdomain", relayTunnelBaseDomain: "tunnel.aigc.zj.cn" })))
      .toBe("https://abc123-3000.tunnel.aigc.zj.cn/");
  });
  it("localhost:port/path → 隧道 URL 保留子路径(path 模式)", () => {
    expect(maybeRewriteToTunnel("localhost:3000/admin", S({})))
      .toBe("https://aigc.zj.cn/relay/t/abc123/3000/admin");
  });
  it("已是 /t/ 隧道 URL 不重复改写", () => {
    expect(maybeRewriteToTunnel("https://aigc.zj.cn/relay/t/abc123/3000/", S({}))).toBeNull();
  });
  it("subdomain 模式:已是子域 URL 不重复改写", () => {
    expect(maybeRewriteToTunnel(
      "https://abc123-3000.tunnel.aigc.zj.cn/",
      S({ relayTunnelMode: "subdomain", relayTunnelBaseDomain: "tunnel.aigc.zj.cn" })
    )).toBeNull();
  });
});
