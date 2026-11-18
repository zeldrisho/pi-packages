import { execFile } from "node:child_process";

/** Run a fixed CLI operation with bounded output and caller cancellation. */
export async function runAgy(
  operation: "--version" | "models",
  options: { timeout: number; maxBuffer: number; signal?: AbortSignal },
): Promise<string | undefined> {
  options.signal?.throwIfAborted();

  return new Promise((resolve, reject) => {
    execFile(
      "agy",
      [operation],
      {
        timeout: options.timeout,
        maxBuffer: options.maxBuffer,
        signal: options.signal,
        env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
      },
      (error, stdout) => {
        if (options.signal?.aborted === true) {
          reject(options.signal.reason);

          return;
        }

        resolve(error === null ? stdout : undefined);
      },
    );
  });
}
