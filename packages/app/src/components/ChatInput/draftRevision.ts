/**
 * Captures whether the draft changed while an asynchronous send was being
 * durably accepted. Keeping this tiny state machine outside React makes the
 * race deterministic to test without a native renderer.
 */
export class DraftRevision {
  private value = 0;

  capture(): number {
    return this.value;
  }

  change(): void {
    this.value += 1;
  }

  shouldClear(submittedRevision: number, accepted: boolean | void): boolean {
    return accepted !== false && this.value === submittedRevision;
  }
}
