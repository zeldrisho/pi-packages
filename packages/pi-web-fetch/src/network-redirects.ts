import type { IncomingMessage } from "node:http";
import { awaitWithAbort } from "./abort";
import { validateRemoteUrl, type ValidatedTarget } from "./network-policy";
import { requestPinned, responseHeader } from "./network-transport";

/** Maximum number of HTTP redirects to follow before aborting. */
export const FETCH_MAX_REDIRECTS = 5;
const MAX_ORIGIN_CONCURRENCY = 4;
const MAX_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 10_000;
const BASE_RETRY_DELAY_MS = 250;

interface OriginState {
  active: number;
  waiting: Array<() => void>;
}
const origins = new Map<string, OriginState>();

/** Optional dependencies for redirect handling (used for testing). */
export interface RedirectDependencies {
  validateUrl?: (value: string | URL) => Promise<ValidatedTarget>;
  request?: (
    target: ValidatedTarget,
    signal: AbortSignal,
    headers?: Readonly<Record<string, string>>,
  ) => Promise<IncomingMessage>;
  random?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

function abortError(): Error {
  const error = new Error("Operation aborted.");
  error.name = "AbortError";
  return error;
}

async function acquireOrigin(origin: string, signal: AbortSignal): Promise<() => void> {
  const state = origins.get(origin) ?? { active: 0, waiting: [] };
  origins.set(origin, state);
  let reserved = false;
  const release = () => {
    state.active -= 1;
    state.waiting.shift()?.();
    if (state.active === 0 && state.waiting.length === 0) origins.delete(origin);
  };
  if (state.active >= MAX_ORIGIN_CONCURRENCY) {
    await new Promise<void>((resolve, reject) => {
      const enter = () => {
        signal.removeEventListener("abort", cancel);
        state.active += 1;
        reserved = true;
        resolve();
      };
      const cancel = () => {
        const index = state.waiting.indexOf(enter);
        if (index >= 0) state.waiting.splice(index, 1);
        reject(abortError());
      };
      if (signal.aborted) cancel();
      else {
        state.waiting.push(enter);
        signal.addEventListener("abort", cancel, { once: true });
      }
    });
  }
  if (signal.aborted) {
    if (reserved) release();
    throw abortError();
  }
  if (!reserved) state.active += 1;
  return release;
}

async function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    function done(): void {
      signal.removeEventListener("abort", cancel);
      resolve();
    }
    function cancel(): void {
      clearTimeout(timer);
      reject(abortError());
    }
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });
  });
}

function retryAfterMilliseconds(value: string | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.min(seconds * 1_000, MAX_RETRY_DELAY_MS);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.min(Math.max(0, date - now), MAX_RETRY_DELAY_MS);
}

async function coordinatedRequest(
  target: ValidatedTarget,
  signal: AbortSignal,
  headers: Readonly<Record<string, string>>,
  dependencies: RedirectDependencies,
): Promise<IncomingMessage> {
  const request =
    dependencies.request ??
    ((value, requestSignal, requestHeaders) =>
      requestPinned(value, requestSignal, { headers: requestHeaders }));
  const random = dependencies.random ?? Math.random;
  const sleep = dependencies.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt += 1) {
    const release = await acquireOrigin(target.url.origin, signal);
    let response: IncomingMessage;
    try {
      response = await request(target, signal, headers);
    } finally {
      release();
    }
    const status = response.statusCode ?? 0;
    if (![429, 503].includes(status) || attempt >= MAX_RETRIES) return response;
    // The retry decision uses headers only. Drop an untrusted error body so it cannot
    // consume unbounded bandwidth while the caller is backing off.
    response.destroy();
    const advertised = retryAfterMilliseconds(responseHeader(response, "retry-after"));
    const exponential = BASE_RETRY_DELAY_MS * 2 ** attempt;
    const jittered = Math.round(exponential * (0.75 + Math.min(1, Math.max(0, random())) * 0.5));
    await sleep(advertised ?? Math.min(jittered, MAX_RETRY_DELAY_MS), signal);
  }
}

/**
 * Requests a URL and follows supported HTTP redirects. Every attempt, redirect, and retry
 * remains inside URL validation, DNS pinning, origin coordination, and caller cancellation.
 */
export async function requestFollowingRedirects(
  value: string | URL,
  signal: AbortSignal,
  dependencies: RedirectDependencies = {},
  headers: Readonly<Record<string, string>> = {},
): Promise<{ target: ValidatedTarget; response: IncomingMessage }> {
  const validateUrl = dependencies.validateUrl ?? validateRemoteUrl;
  let target = await awaitWithAbort(validateUrl(value), signal);
  let requestHeaders = headers;

  for (let redirects = 0; redirects <= FETCH_MAX_REDIRECTS; redirects += 1) {
    const response = await coordinatedRequest(target, signal, requestHeaders, dependencies);
    const status = response.statusCode ?? 0;
    if (![301, 302, 303, 307, 308].includes(status)) return { target, response };

    const location = responseHeader(response, "location");
    if (!location) throw new Error("web_fetch received a redirect without a Location header.");
    if (redirects === FETCH_MAX_REDIRECTS)
      throw new Error("web_fetch followed too many redirects.");
    response.resume();
    target = await awaitWithAbort(validateUrl(new URL(location, target.url)), signal);
    // Validators describe the originally cached resource and must not leak to a redirect target.
    requestHeaders = {};
  }
  throw new Error("web_fetch followed too many redirects.");
}
