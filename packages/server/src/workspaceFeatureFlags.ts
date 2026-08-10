import { resolveWorkspaceFeatureFlags } from "@pocket-code/workspace-core";

export function getServerWorkspaceFeatureFlags() {
  return resolveWorkspaceFeatureFlags({
    catalogV2: process.env.POCKET_CODE_WS_V2_CATALOG,
    resolverV2: process.env.POCKET_CODE_WS_V2_RESOLVER,
    protocolV2: process.env.POCKET_CODE_WS_V2_PROTOCOL,
    importV2: process.env.POCKET_CODE_WS_V2_IMPORT,
    syncV2: process.env.POCKET_CODE_WS_V2_SYNC,
  });
}
