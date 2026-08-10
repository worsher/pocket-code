import { describe, expect, it, vi } from "vitest";
import { deriveSourceIdentity } from "./sourceIdentity.js";
import {
  runImportPipeline,
  type ImportPipelineAdapter,
  type ImportProbe,
} from "./importPipeline.js";

interface Probe extends ImportProbe {
  sourceToken: string;
}
interface Staged {
  stagedSnapshot: string;
  stagingToken: string;
}

function probe(mode: "copy" | "linked" = "copy"): Probe {
  return {
    importMode: mode,
    sourceKind: "directory",
    sourceDeviceId: "phone-a",
    suggestedName: "Example",
    canonicalLocator: "content://projects/example",
    platformHandleId: mode === "linked" ? "handle-1" : undefined,
    contentFingerprint: "snapshot-1",
    sourceSnapshot: "snapshot-1",
    estimatedBytes: 100,
    sourceToken: "source",
  };
}

function adapter(overrides: Partial<ImportPipelineAdapter<string, Probe, Staged, string>> = {}) {
  const value: ImportPipelineAdapter<string, Probe, Staged, string> = {
    probe: vi.fn(async () => probe()),
    stage: vi.fn(async () => ({ stagedSnapshot: "snapshot-1", stagingToken: "staged" })),
    verify: vi.fn(async () => "snapshot-1"),
    commit: vi.fn(async () => "project-1"),
    rollback: vi.fn(async () => undefined),
    ...overrides,
  };
  return value;
}

describe("import pipeline", () => {
  it("runs probe, stage, verify and catalog commit in order", async () => {
    const order: string[] = [];
    const io = adapter({
      probe: vi.fn(async () => {
        order.push("probe");
        return probe();
      }),
      stage: vi.fn(async () => {
        order.push("stage");
        return { stagedSnapshot: "snapshot-1", stagingToken: "s" };
      }),
      verify: vi.fn(async () => {
        order.push("verify");
        return "snapshot-1";
      }),
      commit: vi.fn(async () => {
        order.push("commit");
        return "project-1";
      }),
    });
    const result = await runImportPipeline({ input: "source", existingSources: [], adapter: io });
    expect(result.status).toBe("imported");
    expect(order).toEqual(["probe", "stage", "verify", "commit"]);
    expect(io.rollback).not.toHaveBeenCalled();
  });

  it("requires confirmation for a repeated copy source before staging", async () => {
    const io = adapter();
    const existing = deriveSourceIdentity(probe());
    const result = await runImportPipeline({
      input: "source",
      existingSources: [{ projectId: "existing", identity: existing }],
      adapter: io,
    });
    expect(result).toMatchObject({
      status: "confirmation-required",
      existingProjectId: "existing",
    });
    expect(io.stage).not.toHaveBeenCalled();
  });

  it("blocks a repeated linked source even when weak duplicates are allowed", async () => {
    const linked = probe("linked");
    const io = adapter({ probe: vi.fn(async () => linked) });
    const result = await runImportPipeline({
      input: "source",
      existingSources: [{ projectId: "existing", identity: deriveSourceIdentity(linked) }],
      allowWeakDuplicate: true,
      adapter: io,
    });
    expect(result.status).toBe("blocked");
    expect(io.stage).not.toHaveBeenCalled();
  });

  it("rolls back staging when verification or commit fails", async () => {
    const verifyFailure = adapter({ verify: vi.fn(async () => "different") });
    await expect(
      runImportPipeline({ input: "source", existingSources: [], adapter: verifyFailure })
    ).rejects.toThrow("snapshot verification");
    expect(verifyFailure.rollback).toHaveBeenCalledTimes(1);

    const commitFailure = adapter({
      commit: vi.fn(async () => {
        throw new Error("catalog full");
      }),
    });
    await expect(
      runImportPipeline({ input: "source", existingSources: [], adapter: commitFailure })
    ).rejects.toThrow("catalog full");
    expect(commitFailure.rollback).toHaveBeenCalledTimes(1);
  });
});
