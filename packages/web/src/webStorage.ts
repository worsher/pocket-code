// ── Web 端设置持久化(localStorage 注入,可测) ─────────────────

export interface WebSettings {
  mode: "lan" | "relay";
  /** LAN 直连:ws://开发机IP:端口 */
  serverUrl: string;
  /** relay 模式:relay 地址(https/wss 均可,client-core 会归一化) */
  relayUrl: string;
  /** relay 配对产物 */
  relayMachineId: string;
  relayToken?: string;
  deviceId: string;
}

const KEY = "pocket-code-web-settings";

const DEFAULTS: Omit<WebSettings, "deviceId"> = {
  mode: "lan",
  serverUrl: "ws://localhost:8787",
  relayUrl: "",
  relayMachineId: "",
};

export function createSettingsStore(storage: Pick<Storage, "getItem" | "setItem">) {
  function load(): WebSettings {
    let parsed: Partial<WebSettings> = {};
    try {
      parsed = JSON.parse(storage.getItem(KEY) || "{}");
    } catch {
      /* 损坏的存档按空处理 */
    }
    const deviceId = parsed.deviceId || `web_${Math.random().toString(36).slice(2, 10)}`;
    const settings = { ...DEFAULTS, ...parsed, deviceId };
    if (!parsed.deviceId) storage.setItem(KEY, JSON.stringify(settings));
    return settings;
  }

  function save(patch: Partial<WebSettings>): WebSettings {
    const next = { ...load(), ...patch };
    storage.setItem(KEY, JSON.stringify(next));
    return next;
  }

  return { load, save };
}
