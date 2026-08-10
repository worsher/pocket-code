import { describe, expect, it } from "vitest";
import { acquireWriterLease, handoffWriterLease } from "./writerLease.js";

const LOCAL = "550e8400-e29b-41d4-a716-446655440000";
const REMOTE = "3ca2e8bb-4fe5-4e16-a6ca-99840d666870";

describe("writer lease", () => {
  it("rejects a second active writer and increments generation on handoff", () => {
    const first = acquireWriterLease({ replicaId: LOCAL, now: new Date(0) });
    expect(() =>
      acquireWriterLease({ current: first, replicaId: REMOTE, now: new Date(1) })
    ).toThrow("held by replica");
    const handed = handoffWriterLease({
      current: first,
      fromReplicaId: LOCAL,
      toReplicaId: REMOTE,
      expectedGeneration: 1,
      now: new Date(2),
    });
    expect(handed).toMatchObject({ holderReplicaId: REMOTE, generation: 2 });
  });

  it("rejects stale generation handoff", () => {
    const first = acquireWriterLease({ replicaId: LOCAL });
    expect(() =>
      handoffWriterLease({
        current: first,
        fromReplicaId: LOCAL,
        toReplicaId: REMOTE,
        expectedGeneration: 0,
      })
    ).toThrow("Stale writer handoff generation");
  });
});
