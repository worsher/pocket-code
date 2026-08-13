import { describe, expect, it } from "vitest";
import { DraftRevision } from "./draftRevision";

describe("DraftRevision", () => {
  it("does not clear a second draft when the first asynchronous send resolves", async () => {
    const revision = new DraftRevision();
    revision.change(); // typed A
    const submitted = revision.capture();
    let accept!: (value: boolean) => void;
    const pending = new Promise<boolean>((resolve) => {
      accept = resolve;
    });

    revision.change(); // typed B while A is being persisted
    accept(true);

    expect(revision.shouldClear(submitted, await pending)).toBe(false);
  });

  it("clears only an unchanged accepted draft", () => {
    const revision = new DraftRevision();
    revision.change();
    const submitted = revision.capture();
    expect(revision.shouldClear(submitted, true)).toBe(true);
    expect(revision.shouldClear(submitted, false)).toBe(false);
  });
});
