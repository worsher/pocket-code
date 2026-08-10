import type { AppSettings } from "../store/settings";

function normalizeEndpoint(value: string): string {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

export function usesRemoteWorkspace(settings: AppSettings): boolean {
  return settings.mode === "cloud" || settings.workspaceMode !== "local";
}

/** Stable client-side route for choosing a retained remote replica pre-ack. */
export function getWorkspaceConnectionKey(settings: AppSettings): string | null {
  if (!usesRemoteWorkspace(settings)) return null;
  if (settings.mode === "cloud") {
    return `cloud:${normalizeEndpoint(settings.cloudServerUrl)}`;
  }
  if (settings.workspaceMode === "relay") {
    return `relay:${normalizeEndpoint(settings.relayServerUrl)}:${settings.relayMachineId ?? "unpaired"}`;
  }
  return `server:${normalizeEndpoint(settings.toolServerUrl)}`;
}
