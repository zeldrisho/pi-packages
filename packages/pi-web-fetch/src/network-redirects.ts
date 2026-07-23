import type { IncomingMessage } from "node:http";
import { validateRemoteUrl, type ValidatedTarget } from "./network-policy";
import { requestPinned, responseHeader } from "./network-transport";

export const FETCH_MAX_REDIRECTS = 5;

export interface RedirectDependencies {
  validateUrl?: (value: string | URL) => Promise<ValidatedTarget>;
  request?: (target: ValidatedTarget, signal: AbortSignal) => Promise<IncomingMessage>;
}

function awaitWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = (): void => {
      const error = new Error("Operation aborted.");
      error.name = "AbortError";
      finish(() => reject(error));
    };

    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

export async function requestFollowingRedirects(
  value: string | URL,
  signal: AbortSignal,
  dependencies: RedirectDependencies = {},
): Promise<{ target: ValidatedTarget; response: IncomingMessage }> {
  const validateUrl = dependencies.validateUrl ?? validateRemoteUrl;
  const request = dependencies.request ?? requestPinned;
  let target = await awaitWithAbort(validateUrl(value), signal);

  for (let redirects = 0; redirects <= FETCH_MAX_REDIRECTS; redirects += 1) {
    const response = await request(target, signal);
    const status = response.statusCode ?? 0;
    if (![301, 302, 303, 307, 308].includes(status)) return { target, response };

    const location = responseHeader(response, "location");
    if (!location) throw new Error("web_fetch received a redirect without a Location header.");
    if (redirects === FETCH_MAX_REDIRECTS)
      throw new Error("web_fetch followed too many redirects.");
    response.resume();
    target = await awaitWithAbort(validateUrl(new URL(location, target.url)), signal);
  }
  throw new Error("web_fetch followed too many redirects.");
}
