interface InflightEntry<V> {
  controller: AbortController;
  promise: Promise<V>;
  settled: boolean;
  waiters: number;
}

/**
 * Wraps a promise to respect a caller's abort signal without cancelling the underlying operation.
 *
 * @param operation - Promise to wait for
 * @param signal - Optional abort signal for this caller
 * @param cancelledMessage - Error message to use when signal is aborted
 * @returns Promise that rejects if signal aborts, otherwise resolves with operation result
 */
function waitForCaller<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  cancelledMessage: string,
): Promise<T> {
  if (!signal) return operation;
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(new Error(cancelledMessage));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Coalesces identical operations without allowing one caller to cancel another caller's work. */
export class InflightCoalescer<K, V> {
  readonly #entries = new Map<K, InflightEntry<V>>();

  constructor(readonly maxEntries: number) {}

  /**
   * Gets the number of currently in-flight operations.
   *
   * @returns Count of active operations
   */
  get size(): number {
    return this.#entries.size;
  }

  /**
   * Runs an operation, coalescing with any identical in-flight operation.
   *
   * @param key - Operation key for coalescing identical operations
   * @param operation - Function that performs the operation
   * @param signal - Optional abort signal for this caller
   * @param cancelledMessage - Error message when signal is aborted
   * @returns Promise resolving to the operation result
   */
  async run(
    key: K,
    operation: (signal: AbortSignal | undefined) => Promise<V>,
    signal: AbortSignal | undefined,
    cancelledMessage: string,
  ): Promise<V> {
    let entry = this.#entries.get(key);
    if (!entry) {
      if (this.#entries.size >= this.maxEntries) return operation(signal);
      const controller = new AbortController();
      entry = {
        controller,
        promise: Promise.resolve().then(() => operation(controller.signal)),
        settled: false,
        waiters: 0,
      };
      this.#entries.set(key, entry);
      const created = entry;
      void created.promise.then(
        () => this.#settle(key, created),
        () => this.#settle(key, created),
      );
    }

    entry.waiters += 1;
    try {
      return await waitForCaller(entry.promise, signal, cancelledMessage);
    } finally {
      entry.waiters -= 1;
      if (entry.waiters === 0 && !entry.settled) entry.controller.abort();
    }
  }

  #settle(key: K, entry: InflightEntry<V>): void {
    entry.settled = true;
    if (this.#entries.get(key) === entry) this.#entries.delete(key);
  }
}
