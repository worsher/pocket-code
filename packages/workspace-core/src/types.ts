declare const projectIdBrand: unique symbol;
declare const replicaIdBrand: unique symbol;
declare const legacyProjectIdBrand: unique symbol;

export type ProjectId = string & { readonly [projectIdBrand]: true };
export type ReplicaId = string & { readonly [replicaIdBrand]: true };
export type LegacyProjectId = string & { readonly [legacyProjectIdBrand]: true };

export type ReplicaKind = "mobile" | "cloud" | "dev-binding";
export type ReplicaRole = "writer" | "mirror";
export type ReplicaStatus =
  | "clean"
  | "dirty"
  | "syncing"
  | "conflict"
  | "missing"
  | "permission-lost";

export interface WorkspaceCapabilities {
  readonly read: boolean;
  readonly write: boolean;
  readonly execute: boolean;
  readonly syncBack: boolean;
}

/**
 * The only physical workspace representation accepted by path consumers.
 * Project and replica IDs remain opaque catalog keys; roots are resolved by a
 * platform-specific WorkspaceResolver.
 */
export interface WorkspaceHandle {
  readonly projectId: ProjectId;
  readonly replicaId: ReplicaId;
  readonly generation: number;
  readonly storageUri: string;
  readonly shellPath?: string;
  readonly worktreeRoot: string;
  readonly stateRoot: string;
  readonly cacheRoot: string;
  readonly capabilities: WorkspaceCapabilities;
}

export interface WorkspaceScope {
  readonly projectId: ProjectId;
  readonly replicaId: ReplicaId;
  readonly sessionId: string;
  readonly workspaceGeneration: number;
}

export type ImportMode = "copy" | "linked" | "git";
export type ImportSourceKind = "directory" | "archive" | "git";

export type ProjectOrigin =
  | {
      readonly type: "created";
      readonly environment: ReplicaKind;
    }
  | {
      readonly type: "imported";
      readonly mode: ImportMode;
      readonly sourceKind: ImportSourceKind;
    };

export interface ProjectRecord {
  readonly id: ProjectId;
  /** Present only while a legacy catalog entry is discoverable for migration. */
  readonly legacyId?: LegacyProjectId;
  readonly displayName: string;
  readonly origin: ProjectOrigin;
  readonly activeReplicaId?: ReplicaId;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ReplicaLocation =
  | {
      readonly type: "managed";
      /** Catalog-assigned path segment; never derived from projectId. */
      readonly storageKey: string;
    }
  | {
      readonly type: "external";
      readonly storageUri: string;
      readonly shellPath?: string;
    };

export interface ReplicaRecord {
  readonly id: ReplicaId;
  readonly projectId: ProjectId;
  readonly kind: ReplicaKind;
  readonly role: ReplicaRole;
  readonly status: ReplicaStatus;
  readonly generation: number;
  readonly location: ReplicaLocation;
  readonly capabilities: WorkspaceCapabilities;
  readonly sourceIdentity?: SourceIdentity;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SourceIdentityInput {
  readonly importMode: ImportMode;
  readonly sourceKind: ImportSourceKind;
  readonly sourceDeviceId: string;
  readonly stableFileId?: string;
  readonly platformHandleId?: string;
  readonly canonicalLocator?: string;
  readonly gitRemote?: string;
  readonly contentFingerprint?: string;
}

export interface SourceIdentity {
  readonly importMode: ImportMode;
  readonly sourceKind: ImportSourceKind;
  /** Stable physical identity, always scoped to the source device. */
  readonly strongKey?: string;
  /** Advisory identities used to warn without blocking independent copies. */
  readonly weakKeys: readonly string[];
}

export type DuplicateStrength = "strong" | "weak" | "none";

export interface DuplicateMatch {
  readonly strength: DuplicateStrength;
  readonly matchedKey?: string;
}

export type SnapshotId = string;

export interface SyncSnapshots {
  readonly baseSnapshot: SnapshotId | null;
  readonly localSnapshot: SnapshotId | null;
  readonly remoteSnapshot: SnapshotId | null;
}

export type SyncDecision = "noop" | "push" | "pull" | "converged" | "conflict" | "unavailable";

export type SyncPhase =
  | "idle"
  | "preparing"
  | "transferring"
  | "verifying"
  | "applying"
  | "committed"
  | "failed"
  | "conflict"
  | "recovery-required";

export interface SyncCommitEvidence {
  readonly phase: SyncPhase;
  readonly expectedSnapshot: SnapshotId;
  readonly verifiedSnapshot: SnapshotId | null;
  readonly appliedSnapshot: SnapshotId | null;
}

export interface SyncEdge {
  readonly projectId: ProjectId;
  readonly localReplicaId: ReplicaId;
  readonly remoteReplicaId: ReplicaId;
  readonly baseSnapshot: SnapshotId | null;
  readonly phase: SyncPhase;
  readonly updatedAt: string;
}
