const SENSITIVE_QUERY_KEYS = new Set([
  "access_token",
  "api_key",
  "apikey",
  "auth",
  "code",
  "jwt",
  "key",
  "passwd",
  "password",
  "secret",
  "session",
  "sig",
  "signature",
  "token",
]);

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
  for (const key of url.searchParams.keys()) {
    if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) url.searchParams.set(key, "REDACTED");
  }
  return url.href;
}
