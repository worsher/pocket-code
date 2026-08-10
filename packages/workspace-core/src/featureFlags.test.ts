import { describe, expect, it } from "vitest";
import { resolveWorkspaceFeatureFlags } from "./featureFlags.js";

describe("workspace feature flags", () => {
  it("enables the complete v2 stack by default", () => {
    expect(resolveWorkspaceFeatureFlags()).toEqual({
      catalogV2: true,
      resolverV2: true,
      protocolV2: true,
      importV2: true,
      syncV2: true,
    });
  });

  it("cascades catalog and resolver disablement to dependent features", () => {
    expect(resolveWorkspaceFeatureFlags({ catalogV2: "false", syncV2: "true" })).toEqual({
      catalogV2: false,
      resolverV2: false,
      protocolV2: false,
      importV2: false,
      syncV2: false,
    });
    expect(resolveWorkspaceFeatureFlags({ resolverV2: "0" })).toMatchObject({
      catalogV2: true,
      resolverV2: false,
      protocolV2: false,
      importV2: false,
      syncV2: false,
    });
  });

  it("allows protocol, import, and sync to roll out independently", () => {
    expect(
      resolveWorkspaceFeatureFlags({ protocolV2: "off", importV2: "1", syncV2: "false" })
    ).toMatchObject({ protocolV2: false, importV2: true, syncV2: false });
  });
});
