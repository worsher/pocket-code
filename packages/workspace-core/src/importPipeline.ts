import { classifySourceDuplicate, deriveSourceIdentity } from "./sourceIdentity.js";
import type { DuplicateMatch, ImportMode, ImportSourceKind, SourceIdentity } from "./types.js";

export interface ImportProbe {
  readonly importMode: ImportMode;
  readonly sourceKind: ImportSourceKind;
  readonly sourceDeviceId: string;
  readonly suggestedName: string;
  readonly canonicalLocator?: string;
  readonly stableFileId?: string;
  readonly platformHandleId?: string;
  readonly gitRemote?: string;
  readonly contentFingerprint?: string;
  readonly sourceSnapshot: string;
  readonly estimatedBytes: number;
}

export interface ExistingImportSource {
  readonly projectId: string;
  readonly identity: SourceIdentity;
}

export interface StagedImport {
  readonly stagedSnapshot: string;
}

export interface ImportPipelineAdapter<
  TInput,
  TProbe extends ImportProbe,
  TStaged extends StagedImport,
  TCommit,
> {
  probe(input: TInput): Promise<TProbe>;
  stage(probe: TProbe): Promise<TStaged>;
  verify(probe: TProbe, staged: TStaged): Promise<string>;
  commit(args: {
    probe: TProbe;
    staged: TStaged;
    identity: SourceIdentity;
    verifiedSnapshot: string;
  }): Promise<TCommit>;
  rollback(staged: TStaged): Promise<void>;
}

export type ImportPipelineResult<TProbe extends ImportProbe, TCommit> =
  | {
      status: "confirmation-required";
      probe: TProbe;
      duplicate: DuplicateMatch & { strength: "weak" };
      existingProjectId: string;
    }
  | {
      status: "blocked";
      probe: TProbe;
      duplicate: DuplicateMatch & { strength: "strong" };
      existingProjectId: string;
    }
  | {
      status: "imported";
      probe: TProbe;
      identity: SourceIdentity;
      committed: TCommit;
    };

function strongestDuplicate(
  existing: readonly ExistingImportSource[],
  candidate: SourceIdentity
): { projectId: string; match: DuplicateMatch } | null {
  let weak: { projectId: string; match: DuplicateMatch } | null = null;
  for (const source of existing) {
    const match = classifySourceDuplicate(source.identity, candidate);
    if (match.strength === "strong") return { projectId: source.projectId, match };
    if (match.strength === "weak" && !weak) weak = { projectId: source.projectId, match };
  }
  return weak;
}

export async function runImportPipeline<
  TInput,
  TProbe extends ImportProbe,
  TStaged extends StagedImport,
  TCommit,
>(args: {
  input: TInput;
  existingSources: readonly ExistingImportSource[];
  allowWeakDuplicate?: boolean;
  adapter: ImportPipelineAdapter<TInput, TProbe, TStaged, TCommit>;
}): Promise<ImportPipelineResult<TProbe, TCommit>> {
  const probe = await args.adapter.probe(args.input);
  const identity = deriveSourceIdentity(probe);
  const duplicate = strongestDuplicate(args.existingSources, identity);
  if (duplicate?.match.strength === "strong") {
    return {
      status: "blocked",
      probe,
      duplicate: duplicate.match as DuplicateMatch & { strength: "strong" },
      existingProjectId: duplicate.projectId,
    };
  }
  if (duplicate?.match.strength === "weak" && !args.allowWeakDuplicate) {
    return {
      status: "confirmation-required",
      probe,
      duplicate: duplicate.match as DuplicateMatch & { strength: "weak" },
      existingProjectId: duplicate.projectId,
    };
  }

  const staged = await args.adapter.stage(probe);
  try {
    const verifiedSnapshot = await args.adapter.verify(probe, staged);
    if (verifiedSnapshot !== probe.sourceSnapshot || verifiedSnapshot !== staged.stagedSnapshot) {
      throw new Error("Imported files failed snapshot verification");
    }
    const committed = await args.adapter.commit({
      probe,
      staged,
      identity,
      verifiedSnapshot,
    });
    return { status: "imported", probe, identity, committed };
  } catch (error) {
    await args.adapter.rollback(staged).catch(() => undefined);
    throw error;
  }
}
