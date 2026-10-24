/** Metadata source used by the official OpenCode v2 installer. */
export const CLI_UPDATE_URL = "https://opencode.ai/update/api/latest/cli/npm";

/** Fixed fallback; never follow a URL supplied by remote metadata. */
export const CLI_NPM_URL = "https://registry.npmjs.org/@opencode%2fcli/latest";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const LOOKUP_TIMEOUT_MS = 5_000;

const MAX_METADATA_BYTES = 64 * 1024;

const VERSION_PATTERN = /^[1-9]\d*\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

interface CachedVersion {
  version: string;
  expiresAt: number;
}

interface PendingLookup {
  controller: AbortController;
  promise: Promise<string>;
  waiters: number;
}

/** Accepts bounded stable versions only, excluding prereleases and header controls. */
function isVersion(value: unknown): value is string {
  return typeof value === "string" && value.length <= 32 && VERSION_PATTERN.test(value);
}

/** Checks the official latest CLI npm channel and its expected package identity. */
function isUpdateMetadata(value: unknown): value is { version: string } {
  if (value === null || typeof value !== "object") return false;

  if (!("version" in value) || !isVersion(value.version)) return false;

  if (!("channel" in value) || value.channel !== "latest") return false;

  if (!("name" in value) || value.name !== "cli") return false;

  if (!("distribution" in value) || value.distribution !== "npm") return false;

  if (!("active" in value) || value.active !== true) return false;

  if (!("metadata" in value) || value.metadata === null || typeof value.metadata !== "object")
    return false;

  return "package" in value.metadata && value.metadata.package === "@opencode/cli";
}

/** Checks the scoped npm package identity before accepting its version. */
function isNpmMetadata(value: unknown): value is { version: string } {
  if (value === null || typeof value !== "object") return false;

  return (
    "name" in value &&
    value.name === "@opencode/cli" &&
    "version" in value &&
    isVersion(value.version)
  );
}

/** Reads bounded JSON from a fixed HTTPS endpoint without credentials or redirects. */
async function fetchVersion(
  fetcher: typeof fetch,
  url: string,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetcher(url, {
    headers: { accept: "application/json" },
    credentials: "omit",
    redirect: "error",
    signal,
  });

  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {
      // Keep the original HTTP failure if cleanup fails.
    });
    throw new Error("OpenCode CLI version metadata is unavailable");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      bytes += value.byteLength;

      if (bytes > MAX_METADATA_BYTES) throw new Error("OpenCode CLI version metadata is too large");

      text += decoder.decode(value, { stream: true });
    }

    text += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {
      // Preserve the read, size-limit, decoding, or cancellation failure.
    });
    reader.releaseLock();
  }

  signal.throwIfAborted();
  const metadata: unknown = JSON.parse(text);

  if (url === CLI_UPDATE_URL) {
    if (isUpdateMetadata(metadata)) return metadata.version;
  } else if (isNpmMetadata(metadata)) return metadata.version;

  throw new Error("OpenCode CLI version metadata is invalid");
}

/**
 * Falls back to npm only on a source failure, never after caller cancellation.
 * Each source has a five-second abort deadline.
 *
 * @throws The caller's abort reason, or an Error when neither source resolves a version
 */
async function lookupVersion(fetcher: typeof fetch, signal: AbortSignal): Promise<string> {
  try {
    return await fetchVersion(
      fetcher,
      CLI_UPDATE_URL,
      AbortSignal.any([signal, AbortSignal.timeout(LOOKUP_TIMEOUT_MS)]),
    );
  } catch {
    signal.throwIfAborted();
  }

  try {
    return await fetchVersion(
      fetcher,
      CLI_NPM_URL,
      AbortSignal.any([signal, AbortSignal.timeout(LOOKUP_TIMEOUT_MS)]),
    );
  } catch {
    signal.throwIfAborted();
    throw new Error(
      "Cannot resolve the current OpenCode CLI version. Check your connection and retry.",
    );
  }
}

/** Waits independently so aborting one consumer does not cancel its siblings. */
function waitForVersion(promise: Promise<string>, signal?: AbortSignal): Promise<string> {
  if (!signal) return promise;

  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };

    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (version) => {
        signal.removeEventListener("abort", abort);
        resolve(version);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );

    if (signal.aborted) abort();
  });
}

/**
 * Creates a lazy runtime resolver with a 24-hour in-memory cache and shared lookup.
 * No network request occurs until called. The last canceled waiter aborts the
 * lookup; failures are not cached and no fabricated or bundled version is used.
 *
 * @param now - Clock returning milliseconds since the Unix epoch for cache expiry
 * @returns A resolver that rejects with the caller's abort reason, or an Error
 *   if both metadata sources fail; expired cached versions are not returned
 */
export function createCliVersionResolver(fetcher: typeof fetch, now = Date.now) {
  let cached: CachedVersion | undefined;
  let pending: PendingLookup | undefined;

  return async (signal?: AbortSignal): Promise<string> => {
    signal?.throwIfAborted();

    if (cached && now() < cached.expiresAt) return cached.version;

    if (!pending) {
      const controller = new AbortController();

      const promise = lookupVersion(fetcher, controller.signal)
        .then((version) => {
          controller.signal.throwIfAborted();
          cached = { version, expiresAt: now() + CACHE_TTL_MS };

          return version;
        })
        .finally(() => {
          if (pending?.controller === controller) pending = undefined;
        });

      pending = { controller, promise, waiters: 0 };
    }

    const lookup = pending;
    lookup.waiters += 1;

    try {
      return await waitForVersion(lookup.promise, signal);
    } finally {
      lookup.waiters -= 1;

      if (lookup.waiters === 0 && pending === lookup) {
        pending = undefined;
        lookup.controller.abort();
      }
    }
  };
}
