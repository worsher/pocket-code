import { AsyncLocalStorage } from "async_hooks";

/** Keeps concurrent handler emissions bound to the relay request that created them. */
export class RequestCorrelationContext {
  private readonly storage = new AsyncLocalStorage<string>();

  run<T>(requestId: string, task: () => T): T {
    return this.storage.run(requestId, task);
  }

  current(fallback: string): string {
    return this.storage.getStore() ?? fallback;
  }
}
