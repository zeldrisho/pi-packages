import type { IncomingHttpHeaders, IncomingMessage } from "node:http";

/** Maximum number of cookies retained by one jar. */
const MAX_COOKIES = 128;

/** Maximum accepted cookie value length in characters. */
const MAX_COOKIE_VALUE_CHARACTERS = 4_096;

/** Maximum accepted cookie name length in characters. */
const MAX_COOKIE_NAME_CHARACTERS = 256;

/** RFC 6265 cookie-name token characters. */
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Returns whether a value contains a control character that cookie headers must not carry. */
function hasInvalidCookieCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code <= 0x1f || code === 0x7f) return true;
  }

  return false;
}

interface StoredCookie {
  name: string;
  value: string;
  origin: string;
  path: string;
  secure: boolean;
  createdAt: number;
  expiresAt?: number;
}

interface ParsedCookie {
  name: string;
  value: string;
  path: string;
  secure: boolean;
  expiresAt?: number;
}

/** Returns the default cookie path for a request path, per RFC 6265 section 5.1.4. */
function defaultCookiePath(pathname: string): string {
  if (!pathname.startsWith("/")) return "/";

  const index = pathname.lastIndexOf("/");

  return index <= 0 ? "/" : pathname.slice(0, index);
}

/** Returns whether a request path is covered by a cookie path. */
function pathMatches(pathname: string, cookiePath: string): boolean {
  if (pathname === cookiePath) return true;

  if (!pathname.startsWith(cookiePath)) return false;

  return cookiePath.endsWith("/") || pathname[cookiePath.length] === "/";
}

/** Returns whether a response host may set a cookie for the supplied domain attribute. */
function domainMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/** Normalizes a Domain attribute value, rejecting values that cannot match the response host. */
function normalizeDomain(raw: string, hostname: string): string | undefined {
  const domain = raw.trim().toLowerCase().replace(/^\./, "");

  if (!domain || hasInvalidCookieCharacter(domain) || domain.includes("..")) return undefined;

  if (!domainMatches(hostname, domain)) return undefined;

  return domain;
}

/** Parses one Set-Cookie header into the subset of attributes this jar uses. */
function parseSetCookie(raw: string, url: URL, now: number): ParsedCookie | undefined {
  const parts = raw.split(";");
  const pair = parts[0]?.trim() ?? "";
  const separator = pair.indexOf("=");

  if (separator <= 0) return undefined;

  const name = pair.slice(0, separator).trim();
  const value = pair.slice(separator + 1).trim();

  if (
    name.length === 0 ||
    name.length > MAX_COOKIE_NAME_CHARACTERS ||
    !COOKIE_NAME.test(name) ||
    value.length > MAX_COOKIE_VALUE_CHARACTERS ||
    hasInvalidCookieCharacter(value)
  ) {
    return undefined;
  }

  let path = defaultCookiePath(url.pathname || "/");
  let secure = false;
  let maxAge: number | undefined;
  let expires: number | undefined;

  for (let index = 1; index < parts.length; index += 1) {
    const attribute = parts[index]?.trim() ?? "";
    const equals = attribute.indexOf("=");

    const attributeName = (equals === -1 ? attribute : attribute.slice(0, equals))
      .trim()
      .toLowerCase();

    const attributeValue = equals === -1 ? "" : attribute.slice(equals + 1).trim();

    if (attributeName === "secure") {
      secure = true;
      continue;
    }

    if (attributeName === "path" && attributeValue.startsWith("/")) {
      if (!hasInvalidCookieCharacter(attributeValue)) path = attributeValue;

      continue;
    }

    if (attributeName === "domain") {
      if (normalizeDomain(attributeValue, url.hostname) === undefined) return undefined;

      continue;
    }

    if (attributeName === "max-age") {
      const seconds = Number(attributeValue);

      if (Number.isInteger(seconds)) maxAge = seconds;

      continue;
    }

    if (attributeName === "expires") {
      const parsed = Date.parse(attributeValue);

      if (Number.isFinite(parsed)) expires = parsed;
    }
  }

  const expiresAt =
    maxAge === undefined
      ? expires
      : maxAge <= 0
        ? now - 1
        : now + Math.min(maxAge, 31_536_000) * 1_000;

  return { name, value, path, secure, expiresAt };
}

/** Returns every Set-Cookie value from a response without relying on comma splitting. */
function setCookieValues(headers: IncomingHttpHeaders): string[] {
  const value = headers["set-cookie"];

  if (Array.isArray(value)) return value;

  return value === undefined ? [] : [value];
}

/**
 * A bounded, origin-scoped cookie jar used for one web fetch acquisition.
 *
 * Cookies are accepted only for the origin that supplied them and are never
 * persisted, logged, or sent to another origin. Domain attributes must match the
 * response host; the jar still scopes the stored cookie to that exact origin,
 * which is stricter than a browser and appropriate for challenge handshakes.
 */
export class CookieJar {
  readonly #cookies = new Map<string, StoredCookie>();

  /** Number of unexpired cookies currently stored. */
  get size(): number {
    return this.#cookies.size;
  }

  /**
   * Stores cookies supplied by a response for the given request URL.
   *
   * @param response - The HTTP response whose Set-Cookie headers should be stored.
   * @param url - The final URL that produced the response.
   */
  store(response: Pick<IncomingMessage, "headers">, url: URL): void {
    const now = Date.now();

    for (const raw of setCookieValues(response.headers)) {
      const parsed = parseSetCookie(raw, url, now);

      if (!parsed) continue;

      const key = `${url.origin}\0${parsed.name}\0${parsed.path}`;
      this.#cookies.delete(key);

      if (parsed.expiresAt !== undefined && parsed.expiresAt <= now) continue;

      this.#cookies.set(key, {
        name: parsed.name,
        value: parsed.value,
        origin: url.origin,
        path: parsed.path,
        secure: parsed.secure,
        createdAt: now,
        expiresAt: parsed.expiresAt,
      });
    }

    this.#evict();
  }

  /**
   * Stores a challenge token returned by a resolver.
   *
   * The token is untrusted input. It is accepted only for the target origin,
   * scoped to the whole origin, and held in memory for the current acquisition.
   *
   * @param name - Cookie name
   * @param value - Cookie value
   * @param url - The page URL the cookie belongs to
   * @returns Whether the cookie was accepted
   */
  set(name: string, value: string, url: URL): boolean {
    const token = value.trim();

    if (
      name.length === 0 ||
      name.length > MAX_COOKIE_NAME_CHARACTERS ||
      !COOKIE_NAME.test(name) ||
      token.length === 0 ||
      token.length > MAX_COOKIE_VALUE_CHARACTERS ||
      hasInvalidCookieCharacter(token) ||
      /[\s";,\\]/u.test(token)
    ) {
      return false;
    }

    const key = `${url.origin}\0${name}\0/`;
    this.#cookies.delete(key);
    this.#cookies.set(key, {
      name,
      value: token,
      origin: url.origin,
      path: "/",
      secure: url.protocol === "https:",
      createdAt: Date.now(),
    });
    this.#evict();

    return true;
  }

  /**
   * Returns a Cookie header value for a URL, excluding expired, insecure, and
   * cross-origin cookies.
   *
   * @param url - The request URL.
   * @returns A serialized Cookie header value, or undefined when no cookie matches.
   */
  headerFor(url: URL): string | undefined {
    const now = Date.now();
    const matches: StoredCookie[] = [];

    for (const [key, cookie] of this.#cookies) {
      if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) {
        this.#cookies.delete(key);
        continue;
      }

      if (cookie.origin !== url.origin) continue;

      if (cookie.secure && url.protocol !== "https:") continue;

      if (!pathMatches(url.pathname || "/", cookie.path)) continue;

      matches.push(cookie);
    }

    if (matches.length === 0) return undefined;

    matches.sort((left, right) => {
      const pathOrder = right.path.length - left.path.length;

      return pathOrder !== 0 ? pathOrder : left.createdAt - right.createdAt;
    });

    return matches.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  }

  /** Drops oldest cookies until the jar is within its entry bound. */
  #evict(): void {
    while (this.#cookies.size > MAX_COOKIES) {
      const oldest = this.#cookies.keys().next().value;

      if (oldest === undefined) return;
      this.#cookies.delete(oldest);
    }
  }
}
