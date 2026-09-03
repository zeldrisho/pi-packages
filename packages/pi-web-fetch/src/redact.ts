const SENSITIVE_QUERY_KEYS = new Set([
  "access_token",
  "api_key",
  "apikey",
  "auth",
  "client_secret",
  "code",
  "jwt",
  "key",
  "passwd",
  "password",
  "refresh_token",
  "secret",
  "session",
  "sig",
  "signature",
  "token",
]);

function redactSensitiveParams(params: URLSearchParams): boolean {
  let redacted = false;
  for (const key of params.keys()) {
    if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
      params.set(key, "REDACTED");
      redacted = true;
    }
  }
  return redacted;
}

/**
 * Returns a URL safe to show in tool progress, results, and errors.
 *
 * Network requests continue to use the original URL. User information is removed and
 * common credential-bearing query parameters retain their names but not their values.
 * Invalid input is replaced rather than echoed because it may still contain secrets.
 */
export function redactUrlForDisplay(value: string | URL): string {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value.href) : new URL(value);
  } catch {
    return "[invalid URL]";
  }

  url.username = "";
  url.password = "";
  redactSensitiveParams(url.searchParams);
  if (url.hash.length > 1) {
    const fragmentParams = new URLSearchParams(url.hash.slice(1));
    if (redactSensitiveParams(fragmentParams)) url.hash = fragmentParams.toString();
  }
  return url.href;
}
