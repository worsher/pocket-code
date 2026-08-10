import { describe, expect, it } from "vitest";
import type { AppSettings } from "../store/settings";
import { getWorkspaceConnectionKey, usesRemoteWorkspace } from "./workspaceConnection";

const base: AppSettings = {
  mode: "cloud",
  workspaceMode: "local",
  cloudServerUrl: "ws://cloud",
  toolServerUrl: "ws://tool",
  relayServerUrl: "wss://relay",
  apiKeys: {},
  defaultModel: "auto",
  gitCredentials: [],
};

describe("workspace connection identity", () => {
  it("separates cloud, direct developer server and relay machine routes", () => {
    expect(
      getWorkspaceConnectionKey({
        ...base,
        mode: "cloud",
        cloudServerUrl: "WSS://Cloud.Example/ws/",
      }),
    ).toBe("cloud:wss://cloud.example/ws");
    expect(
      getWorkspaceConnectionKey({
        ...base,
        mode: "geek",
        workspaceMode: "server",
        toolServerUrl: "ws://127.0.0.1:3100/",
      }),
    ).toBe("server:ws://127.0.0.1:3100");
    expect(
      getWorkspaceConnectionKey({
        ...base,
        mode: "geek",
        workspaceMode: "relay",
        relayServerUrl: "wss://relay.example/",
        relayMachineId: "machine-a",
      }),
    ).toBe("relay:wss://relay.example:machine-a");
  });

  it("uses the local replica only for geek local mode", () => {
    const local = { ...base, mode: "geek" as const, workspaceMode: "local" as const };
    expect(usesRemoteWorkspace(local)).toBe(false);
    expect(getWorkspaceConnectionKey(local)).toBeNull();
  });
});
