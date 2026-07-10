import { describe, it, expect } from "vitest";
import crypto from "crypto";
import { requireRelaySecret, verifyDaemonAuth, HMAC_TIME_WINDOW_MS, isDiscoveryEnabled, getTunnelToken, verifyTunnelToken, isTunnelCookieSecure, getTunnelMode, getTunnelBaseDomain, type TunnelMode } from "./config.js";

describe("requireRelaySecret", () => {
  it("returns the secret when set", () => {
    expect(requireRelaySecret({ RELAY_SECRET: "s3cret" })).toBe("s3cret");
  });
  it("throws with guidance when missing or blank", () => {
    expect(() => requireRelaySecret({})).toThrow(/openssl rand -hex 32/);
    expect(() => requireRelaySecret({ RELAY_SECRET: "  " })).toThrow(/RELAY_SECRET/);
  });
});

describe("verifyDaemonAuth", () => {
  const secret = "test-secret";
  const now = 1_000_000_000_000;
  const hmac = (machineId: string, ts: number, s = secret) =>
    crypto.createHmac("sha256", s).update(machineId + ts).digest("hex");

  it("accepts a valid HMAC within the time window", () => {
    expect(verifyDaemonAuth(secret, "m_1", now, hmac("m_1", now), now)).toEqual({ ok: true });
  });
  it("rejects missing authToken/timestamp", () => {
    expect(verifyDaemonAuth(secret, "m_1", undefined, undefined, now).ok).toBe(false);
    expect(verifyDaemonAuth(secret, "m_1", now, undefined, now).ok).toBe(false);
  });
  it("rejects expired timestamp", () => {
    const old = now - HMAC_TIME_WINDOW_MS - 1;
    expect(verifyDaemonAuth(secret, "m_1", old, hmac("m_1", old), now).ok).toBe(false);
  });
  it("rejects wrong secret", () => {
    expect(verifyDaemonAuth(secret, "m_1", now, hmac("m_1", now, "other"), now).ok).toBe(false);
  });
  it("rejects HMAC computed for a different machineId (防冒名)", () => {
    expect(verifyDaemonAuth(secret, "m_victim", now, hmac("m_attacker", now), now).ok).toBe(false);
  });
  it("does not throw on a token of wrong length (原 timingSafeEqual 长度 bug)", () => {
    expect(() => verifyDaemonAuth(secret, "m_1", now, "abcd", now)).not.toThrow();
    expect(verifyDaemonAuth(secret, "m_1", now, "abcd", now).ok).toBe(false);
  });
});

describe("isDiscoveryEnabled", () => {
  it("defaults to on when unset/empty/other values", () => {
    expect(isDiscoveryEnabled({})).toBe(true);
    expect(isDiscoveryEnabled({ RELAY_DISCOVERY: "" })).toBe(true);
    expect(isDiscoveryEnabled({ RELAY_DISCOVERY: "on" })).toBe(true);
  });
  it("turns off only on 'off' (case/space insensitive)", () => {
    expect(isDiscoveryEnabled({ RELAY_DISCOVERY: "off" })).toBe(false);
    expect(isDiscoveryEnabled({ RELAY_DISCOVERY: " OFF " })).toBe(false);
  });
});

describe("tunnel token", () => {
  it("getTunnelToken: 空/未设置 → null(不启用)", () => {
    expect(getTunnelToken({})).toBeNull();
    expect(getTunnelToken({ TUNNEL_TOKEN: "  " })).toBeNull();
    expect(getTunnelToken({ TUNNEL_TOKEN: " tok " })).toBe("tok");
  });
  it("verifyTunnelToken: 等值通过,错值/缺失/前缀不通过", () => {
    expect(verifyTunnelToken("tok", "tok")).toBe(true);
    expect(verifyTunnelToken("tok", "bad")).toBe(false);
    expect(verifyTunnelToken("tok", "to")).toBe(false);
    expect(verifyTunnelToken("tok", undefined)).toBe(false);
    expect(verifyTunnelToken("tok", null)).toBe(false);
  });
});

describe("isTunnelCookieSecure", () => {
  it("defaults to on when unset/empty/other values", () => {
    expect(isTunnelCookieSecure({})).toBe(true);
    expect(isTunnelCookieSecure({ TUNNEL_COOKIE_SECURE: "" })).toBe(true);
    expect(isTunnelCookieSecure({ TUNNEL_COOKIE_SECURE: "on" })).toBe(true);
  });
  it("turns off only on 'off' (case/space insensitive) — VPS 裸 IP/纯 http 场景", () => {
    expect(isTunnelCookieSecure({ TUNNEL_COOKIE_SECURE: "off" })).toBe(false);
    expect(isTunnelCookieSecure({ TUNNEL_COOKIE_SECURE: " OFF " })).toBe(false);
  });
});

describe("getTunnelMode", () => {
  it("默认 subdomain(未设置/空/其他值)", () => {
    expect(getTunnelMode({})).toBe("subdomain");
    expect(getTunnelMode({ TUNNEL_MODE: "" })).toBe("subdomain");
    expect(getTunnelMode({ TUNNEL_MODE: "weird" })).toBe("subdomain");
  });
  it("仅 'path' 切换(大小写/空格不敏感)", () => {
    expect(getTunnelMode({ TUNNEL_MODE: "path" })).toBe("path");
    expect(getTunnelMode({ TUNNEL_MODE: " PATH " })).toBe("path");
  });
});

describe("getTunnelBaseDomain", () => {
  it("trim 后非空返回,空/未设置返回 null", () => {
    expect(getTunnelBaseDomain({})).toBeNull();
    expect(getTunnelBaseDomain({ TUNNEL_BASE_DOMAIN: "  " })).toBeNull();
    expect(getTunnelBaseDomain({ TUNNEL_BASE_DOMAIN: " tunnel.aigc.zj.cn " })).toBe("tunnel.aigc.zj.cn");
  });
});
