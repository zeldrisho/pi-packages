import type { IncomingMessage } from "node:http";
import { awaitWithAbort } from "./abort";
import { validateRemoteUrl, type ValidatedTarget } from "./network-policy";
import { requestPinned, responseHeader } from "./network-transport";

export const FETCH_MAX_REDIRECTS = 5;

export interface RedirectDependencies {
  validateUrl?: (value: string | URL) => Promise<ValidatedTarget>;
  request?: (target: ValidatedTarget, signal: AbortSignal) => Promise<IncomingMessage>;
}

/**
 * Requests a URL and follows supported HTTP redirects.
 *
 * @param value - The initial URL to request
 * @param signal - Signal used to cancel validation and requests
 * @param dependencies - Optional URL-validation and request implementations
 * @returns The final validated target and its HTTP response
 * @throws If a redirect lacks a `Location` header or the redirect limit is exceeded
 */
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
