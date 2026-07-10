// ── 隧道预览 URL 拼装(模式感知,从 PreviewTab 抽出以可测) ──
// path 模式:<relayHttpBase>/t/<id>/<port>/  ;  subdomain 模式:<id>-<port>.<baseDomain>/

export interface TunnelInfo {
  mode: "subdomain" | "path";
  baseDomain: string | null;
}

interface TunnelSettings {
  workspaceMode?: string;
  relayServerUrl?: string;
  relayMachineId?: string;
  relayTunnelMode?: "subdomain" | "path";
  relayTunnelBaseDomain?: string | null;
}

function toHttp(wsUrl: string): string {
  return wsUrl.replace(/^ws:\/\//, "http://").replace(/^wss:\/\//, "https://");
}

export function buildTunnelUrl(
  relayServerUrl: string,
  machineId: string,
  port: number,
  info?: TunnelInfo
): string {
  const httpBase = toHttp(relayServerUrl);
  if (info?.mode === "subdomain" && info.baseDomain) {
    const scheme = httpBase.startsWith("https://") ? "https" : "http";
    return `${scheme}://${machineId}-${port}.${info.baseDomain}/`;
  }
  // path 模式(默认 / 回退)
  return `${httpBase.replace(/\/$/, "")}/t/${machineId}/${port}/`;
}

/** 已经是隧道 URL(path 或 subdomain)则不重复改写。 */
function isAlreadyTunnel(input: string, info?: TunnelInfo): boolean {
  if (/\/t\/[^/]+\/\d+/.test(input)) return true;
  if (info?.mode === "subdomain" && info.baseDomain) {
    const esc = info.baseDomain.replace(/[.]/g, "\\.");
    if (new RegExp(`^https?://[0-9a-z]+-\\d+\\.${esc}`, "i").test(input)) return true;
  }
  return false;
}

export function maybeRewriteToTunnel(input: string, settings: TunnelSettings | undefined): string | null {
  if (!settings || settings.workspaceMode !== "relay") return null;
  const { relayServerUrl, relayMachineId } = settings;
  if (!relayServerUrl || !relayMachineId) return null;

  const info: TunnelInfo | undefined = settings.relayTunnelMode
    ? { mode: settings.relayTunnelMode, baseDomain: settings.relayTunnelBaseDomain ?? null }
    : undefined;

  if (isAlreadyTunnel(input, info)) return null;

  // 裸端口 "3000"
  const bare = input.match(/^(\d{1,5})$/);
  if (bare) {
    return buildTunnelUrl(relayServerUrl, relayMachineId, parseInt(bare[1], 10), info);
  }
  // localhost / 127.0.0.1 (+可选 http:// / 端口 / 子路径)
  const loc = input.match(/^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1)(?::(\d{1,5}))?(\/.*)?$/i);
  if (loc) {
    const port = loc[1] ? parseInt(loc[1], 10) : 80;
    const base = buildTunnelUrl(relayServerUrl, relayMachineId, port, info);
    const rest = loc[2] ? loc[2].replace(/^\//, "") : "";
    return base + rest;
  }
  return null;
}
