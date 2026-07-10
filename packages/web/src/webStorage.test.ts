import { describe, expect, it } from "vitest";
import { createSettingsStore, type WebSettings } from "./webStorage";

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

describe("createSettingsStore", () => {
  it("returns defaults (lan mode, generated deviceId) on empty storage", () => {
    const store = createSettingsStore(fakeStorage());
    const s = store.load();
    expect(s.mode).toBe("lan");
    expect(s.deviceId).toMatch(/^web_/);
  });

  it("falls back to defaults when storage holds a non-object JSON literal", () => {
    const storage = fakeStorage();
    storage.setItem("pocket-code-web-settings", "null");
    const s = createSettingsStore(storage).load();
    expect(s.mode).toBe("lan");
    expect(s.deviceId).toMatch(/^web_/);
  });

  it("persists patches and keeps deviceId stable across loads", () => {
    const storage = fakeStorage();
    const s1 = createSettingsStore(storage).load();
    createSettingsStore(storage).save({ mode: "relay", relayUrl: "wss://aigc.zj.cn/relay" });
    const s2 = createSettingsStore(storage).load();
    expect(s2.mode).toBe("relay");
    expect(s2.relayUrl).toBe("wss://aigc.zj.cn/relay");
    expect(s2.deviceId).toBe(s1.deviceId);
  });
});
