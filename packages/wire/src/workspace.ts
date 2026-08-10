import { z } from "zod";

/**
 * The kind describes where a replica is hosted. It is intentionally not a
 * filesystem path: clients use it only to choose sync and persistence policy.
 */
export const WorkspaceReplicaKind = z.enum(["cloud", "dev-binding"]);

/**
 * Server-authoritative identity for a workspace used by one session.
 *
 * authorityId identifies the server/daemon catalog. replicaId identifies the
 * physical copy inside that catalog. The four scope fields are enough to reject
 * stale events; the remaining fields let the App retain the remote replica.
 */
export const WorkspaceSessionScope = z.object({
  projectId: z.string().uuid(),
  replicaId: z.string().uuid(),
  sessionId: z.string().min(1).max(128),
  workspaceGeneration: z.number().int().positive(),
  authorityId: z.string().uuid(),
  replicaKind: WorkspaceReplicaKind,
});

/** One logical project and this authority's replica of it. */
export const WorkspaceProjectCatalogEntry = z.object({
  projectId: z.string().uuid(),
  displayName: z.string().max(256),
  replicaId: z.string().uuid(),
  workspaceGeneration: z.number().int().positive(),
  authorityId: z.string().uuid(),
  replicaKind: WorkspaceReplicaKind,
  updatedAt: z.number().int().nonnegative(),
});

export type WorkspaceReplicaKindType = z.infer<typeof WorkspaceReplicaKind>;
export type WorkspaceSessionScopeType = z.infer<typeof WorkspaceSessionScope>;
export type WorkspaceProjectCatalogEntryType = z.infer<typeof WorkspaceProjectCatalogEntry>;
