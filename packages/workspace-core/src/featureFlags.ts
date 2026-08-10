export interface WorkspaceFeatureFlags {
  catalogV2: boolean;
  resolverV2: boolean;
  protocolV2: boolean;
  importV2: boolean;
  syncV2: boolean;
}

function enabled(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return !["0", "false", "off", "disabled"].includes(value.trim().toLowerCase());
}

/**
 * Resolves independently deployable Workspace Storage v2 gates while enforcing
 * their dependency order. Disabling an earlier layer always disables its
 * consumers, so a partial rollout cannot accidentally bypass the catalog.
 */
export function resolveWorkspaceFeatureFlags(
  source: Partial<Record<keyof WorkspaceFeatureFlags, string | undefined>> = {}
): WorkspaceFeatureFlags {
  const catalogV2 = enabled(source.catalogV2, true);
  const resolverV2 = catalogV2 && enabled(source.resolverV2, true);
  return {
    catalogV2,
    resolverV2,
    protocolV2: resolverV2 && enabled(source.protocolV2, true),
    importV2: resolverV2 && enabled(source.importV2, true),
    syncV2: resolverV2 && enabled(source.syncV2, true),
  };
}
