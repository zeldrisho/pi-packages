/** Limits complete acquisitions, including slow response bodies and extraction. */
export class AcquisitionAdmission {
  #active = 0;
  readonly #waiting: Array<() => void> = [];

  readonly maxActive: number;
  readonly maxWaiting: number;

  constructor(maxActive: number, maxWaiting: number) {
    this.maxActive = maxActive;
    this.maxWaiting = maxWaiting;
  }

  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();

    if (this.#active >= this.maxActive) {
      if (this.#waiting.length >= this.maxWaiting) {
        throw new Error("web_fetch is busy; too many requests are waiting.");
      }

      await new Promise<void>((resolve, reject) => {
        const enter = () => {
          signal.removeEventListener("abort", cancel);
          this.#active += 1;
          resolve();
        };

        const cancel = () => {
          const index = this.#waiting.indexOf(enter);

          if (index >= 0) this.#waiting.splice(index, 1);
          reject(signal.reason);
        };

        this.#waiting.push(enter);
        signal.addEventListener("abort", cancel, { once: true });

        if (signal.aborted) cancel();
      });
    } else {
      this.#active += 1;
    }

    let released = false;

    const release = () => {
      if (released) return;
      released = true;
      this.#active -= 1;
      this.#waiting.shift()?.();
    };

    if (signal.aborted) {
      release();
      signal.throwIfAborted();
    }

    return release;
  }
}

/** Bound worst-case concurrent downloads without serializing normal subagent use. */
export const acquisitionAdmission = new AcquisitionAdmission(16, 128);
