import { describe, it, expect } from "vitest";
import { rewriteRedirectHeaders } from "./redirectRewrite.js";

const ID = "bda488cfdee21ccc";
const PORT = 3000;
const PFX = `/t/${ID}/${PORT}`;

describe("rewriteRedirectHeaders", () => {
  it("站内绝对路径 Location 补前缀", () => {
    const out = rewriteRedirectHeaders({ location: "/admin" }, ID, PORT);
    expect(out.location).toBe(`${PFX}/admin`);
  });
  it("大小写 Location 键都处理(header 名不区分大小写)", () => {
    const out = rewriteRedirectHeaders({ Location: "/admin" }, ID, PORT);
    // 归一后仍能被浏览器识别;断言值被补前缀(键名保留原样或归一均可,只要值对)
    const val = (out.Location ?? out.location) as string;
    expect(val).toBe(`${PFX}/admin`);
  });
  it("相对路径不动(浏览器基于当前路径解析)", () => {
    const out = rewriteRedirectHeaders({ location: "admin/sub" }, ID, PORT);
    expect(out.location).toBe("admin/sub");
  });
  it("绝对 URL(scheme://)不动", () => {
    const out = rewriteRedirectHeaders({ location: "https://other.com/x" }, ID, PORT);
    expect(out.location).toBe("https://other.com/x");
  });
  it("protocol-relative //host 不动", () => {
    const out = rewriteRedirectHeaders({ location: "//evil.com/x" }, ID, PORT);
    expect(out.location).toBe("//evil.com/x");
  });
  it("无 Location 时 headers 原样返回", () => {
    const input = { "content-type": "text/html", "set-cookie": "a=1; Path=/" };
    expect(rewriteRedirectHeaders(input, ID, PORT)).toEqual(input);
  });
  it("Set-Cookie 一律不改(含 pc_tunnel / pc_tunnel_token / 应用 cookie)", () => {
    const input = {
      location: "/admin",
      "set-cookie": ["pc_tunnel=x:3000; Path=/", "pc_tunnel_token=t; Path=/; HttpOnly", "app_sess=z; Path=/admin"],
    };
    const out = rewriteRedirectHeaders(input, ID, PORT);
    expect(out.location).toBe(`${PFX}/admin`);
    expect(out["set-cookie"]).toEqual(input["set-cookie"]); // 逐条原样
  });
  it("不原地改输入对象", () => {
    const input = { location: "/admin" };
    rewriteRedirectHeaders(input, ID, PORT);
    expect(input.location).toBe("/admin"); // 原对象未被改
  });
});
