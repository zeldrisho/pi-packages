import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { JsonValue, OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import type { OAuthClient } from "./agy-client.ts";
import { isJsonNumber, isJsonObject, isJsonText, nonEmptyText, parseJsonValue } from "./json.ts";
import { resolveOAuthClient } from "./oauth-client.ts";
import { discoverProjectId, stableProjectId } from "./project.ts";

/** Google authorization endpoint for the Antigravity desktop client. */
export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

/** Google token endpoint used for code exchange and refresh. */
export const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Default port and route for the loopback listener. */
const DEFAULT_CALLBACK_PORT = 51_121;

const CALLBACK_PATH = "/oauth-callback";

/** Loopback redirect Google accepts for installed-application clients. */
export const DEFAULT_REDIRECT_URI = `http://localhost:${DEFAULT_CALLBACK_PORT}${CALLBACK_PATH}`;

/** How long the loopback listener waits for a browser redirect. */
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

/** Scopes historically requested by Antigravity clients. */
export const SCOPES = [
  "https://www.googleapis.com/auth/aicode",
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
] as const;

/** OAuth credentials this provider stores, including the Cloud Code project id. */
export interface AntigravityCredentials extends OAuthCredentials {
  projectId: string;
}

/** Access token and project id resolved from stored credentials for one request. */
export interface AntigravityApiKey {
  token: string;
  projectId: string;
}

/** Proof-key pair used for the authorization-code exchange. */
export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** Reads an environment override, ignoring blank values. */
function envOverride(name: string): string | undefined {
  const value = process.env[name];

  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

/** Redirect URI: environment override, otherwise the loopback callback. */
export function redirectUri(): string {
  return envOverride("PI_ANTIGRAVITY_REDIRECT_URI") ?? DEFAULT_REDIRECT_URI;
}

/**
 * Creates a PKCE verifier and its S256 challenge.
 *
 * @param randomBytesSource - Cryptographic random source, injectable for tests
 * @returns The verifier and challenge
 */
export function createPkcePair(
  randomBytesSource: (size: number) => Uint8Array = randomBytes,
): PkcePair {
  const verifier = Buffer.from(randomBytesSource(32)).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  return { verifier, challenge };
}

/**
 * Builds the Google authorization URL for this flow.
 *
 * @param pkce - Verifier challenge
 * @param state - Opaque state value echoed back by the callback
 * @param client - OAuth client discovered from the installed CLI
 * @returns The authorization URL to open in a browser
 */
export function buildAuthUrl(pkce: PkcePair, state: string, client: OAuthClient): string {
  const params = new URLSearchParams({
    client_id: client.id,
    response_type: "code",
    redirect_uri: redirectUri(),
    scope: SCOPES.join(" "),
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    state,
    access_type: "offline",
    prompt: "consent",
  });

  return `${AUTH_URL}?${params.toString()}`;
}

/** Extracts a safe, bounded message from an OAuth error response body. */
function providerErrorMessage(body: string): string {
  const trimmed = body.trim();

  try {
    const parsed = parseJsonValue(trimmed);

    if (isJsonObject(parsed)) {
      const parts = [nonEmptyText(parsed.error), nonEmptyText(parsed.error_description)].filter(
        (part): part is string => part !== undefined,
      );

      if (parts.length > 0) return parts.join(": ").slice(0, 300);
    }
  } catch {
    // Not JSON; fall through to the bounded text form.
  }

  return trimmed.slice(0, 300) || "unknown OAuth error";
}

/** Parsed token response fields this provider needs. */
interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

/**
 * Reads a token response, keeping only the fields this provider needs.
 *
 * @param value - Parsed token endpoint body
 * @returns The token fields, or undefined when the body is not a token response
 */
function readTokenResponse(value: JsonValue | undefined): TokenResponse | undefined {
  if (!isJsonObject(value)) return undefined;

  const accessToken = nonEmptyText(value.access_token);
  const expiresIn = value.expires_in;
  const refreshToken = value.refresh_token;

  if (accessToken === undefined || !isJsonNumber(expiresIn) || expiresIn <= 0) return undefined;

  if (refreshToken !== undefined && !isJsonText(refreshToken)) return undefined;

  const token: TokenResponse = { access_token: accessToken, expires_in: expiresIn };

  if (refreshToken !== undefined) token.refresh_token = refreshToken;

  return token;
}

/** Converts a token lifetime into an absolute expiry with a five-minute safety margin. */
function expiryFrom(expiresIn: number, now: number): number {
  return now + expiresIn * 1000 - 5 * 60 * 1000;
}

/**
 * Exchanges an authorization code for tokens.
 *
 * @param code - Authorization code from the callback
 * @param verifier - PKCE verifier for this flow
 * @param signal - Cancellation for the request
 * @returns Parsed token response
 * @throws If the provider rejects the exchange or omits required fields
 */
async function exchangeCode(
  code: string,
  verifier: string,
  signal: AbortSignal | undefined,
  client: OAuthClient,
): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.id,
      client_secret: client.secret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri(),
      code_verifier: verifier,
    }).toString(),
    redirect: "error",
    signal,
  });

  const body = await response.text();

  if (!response.ok) {
    throw new Error(`Antigravity token exchange failed: ${providerErrorMessage(body)}`);
  }

  const token = readTokenResponse(parseJsonValue(body));

  if (token === undefined) {
    throw new Error("Antigravity token exchange returned an unexpected response");
  }

  if (token.refresh_token === undefined) {
    throw new Error(
      "Antigravity did not return a refresh token. Re-run /login antigravity and allow offline access.",
    );
  }

  return token;
}

/**
 * Refreshes an expired access token.
 *
 * @param credentials - Stored credentials
 * @param signal - Cancellation for the request
 * @param now - Clock used for the expiry margin
 * @returns Updated credentials, keeping the stored project id
 * @throws If the provider rejects the refresh
 */
export async function refreshCredentials(
  credentials: OAuthCredentials,
  signal: AbortSignal | undefined,
  now: number,
): Promise<OAuthCredentials> {
  const client = await resolveOAuthClient(signal);

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.id,
      client_secret: client.secret,
      refresh_token: credentials.refresh,
      grant_type: "refresh_token",
    }).toString(),
    redirect: "error",
    signal,
  });

  const body = await response.text();

  if (!response.ok) {
    throw new Error(`Antigravity token refresh failed: ${providerErrorMessage(body)}`);
  }

  const token = readTokenResponse(parseJsonValue(body));

  if (token === undefined) {
    throw new Error("Antigravity token refresh returned an unexpected response");
  }

  return {
    ...credentials,
    access: token.access_token,
    refresh: token.refresh_token ?? credentials.refresh,
    expires: expiryFrom(token.expires_in, now),
  };
}

/**
 * Encodes credentials as the provider's API key string.
 *
 * @param credentials - Stored credentials
 * @returns JSON carrying the access token and project id
 */
export function getApiKey(credentials: OAuthCredentials): string {
  // SAFETY: stored credential records round-trip through the JSON API key string.
  const storedProject = nonEmptyText(credentials.projectId as JsonValue | undefined);
  const projectId = storedProject ?? stableProjectId("antigravity");

  return JSON.stringify({ token: credentials.access, projectId });
}

/**
 * Decodes the API key string into a request-ready token and project id.
 *
 * @param raw - API key string supplied by Pi
 * @returns Token and project id
 * @throws If credentials are missing or malformed
 */
export function parseApiKey(raw: string | undefined): AntigravityApiKey {
  if (raw === undefined || raw === "") {
    throw new Error("No Antigravity credentials. Run /login antigravity.");
  }

  try {
    const key = readApiKey(parseJsonValue(raw));

    if (key !== undefined) return key;
  } catch {
    // Fall through to the single message below; the parse error may quote credentials.
  }

  throw new Error("Invalid Antigravity credentials. Run /login antigravity.");
}

/**
 * Reads an API key payload from its parsed form.
 *
 * @param value - Parsed credential string
 * @returns The token and project id, or undefined when either is missing
 */
function readApiKey(value: JsonValue | undefined): AntigravityApiKey | undefined {
  if (!isJsonObject(value)) return undefined;

  const token = nonEmptyText(value.token);
  const projectId = nonEmptyText(value.projectId);

  if (token === undefined || projectId === undefined) return undefined;

  return { token, projectId };
}

/** Loopback listener that resolves the authorization code from a browser redirect. */
interface CallbackListener {
  waitForCode: () => Promise<{ code: string; state: string }>;
  close: () => void;
}

/** Minimal HTML response headers for the callback page. */
const CALLBACK_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
  "Referrer-Policy": "no-referrer",
} as const;

/** Escapes text inserted into the callback HTML response. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Extracts the callback listener port from the redirect URI, falling back to the default port. */
function callbackPort(): number {
  try {
    return Number(new URL(redirectUri()).port) || DEFAULT_CALLBACK_PORT;
  } catch {
    return DEFAULT_CALLBACK_PORT;
  }
}

/**
 * Starts the loopback callback listener.
 *
 * Binds to `127.0.0.1` only, accepts one well-formed callback, and never exposes
 * the authorization code in the response body.
 *
 * @param expectedState - State value the callback must echo back
 * @returns Listener handles for waiting and shutdown
 * @throws If the port is already in use
 */
async function startCallbackListener(expectedState: string): Promise<CallbackListener> {
  let settle: ((result: { code: string; state: string }) => void) | undefined;
  let fail: ((error: Error) => void) | undefined;
  let settled = false;
  // oxlint-disable-next-line prefer-const -- startup errors can finish before the timer is armed
  let timer: ReturnType<typeof setTimeout> | undefined;

  const codePromise = new Promise<{ code: string; state: string }>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  // Startup can fail before acquireCode attaches a handler.
  void codePromise.catch(() => {});

  const finish = (action: () => void): void => {
    if (settled) return;
    settled = true;

    if (timer !== undefined) clearTimeout(timer);
    action();
  };

  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    let url: URL;

    try {
      url = new URL(request.url ?? "/", redirectUri());
    } catch {
      response.writeHead(400, CALLBACK_HEADERS);
      response.end("Invalid callback URL.");

      return;
    }

    if (url.pathname !== CALLBACK_PATH) {
      response.writeHead(404, CALLBACK_HEADERS);
      response.end("Antigravity OAuth callback route not found.");

      return;
    }

    const state = url.searchParams.get("state");

    if (state !== expectedState) {
      response.writeHead(400, CALLBACK_HEADERS);
      response.end("Antigravity sign-in failed: state mismatch.");

      return;
    }

    const error = url.searchParams.get("error");

    if (error !== null) {
      response.writeHead(400, CALLBACK_HEADERS);
      response.end(`Antigravity sign-in failed: ${escapeHtml(error.slice(0, 200))}`);
      finish(() => fail?.(new Error(`OAuth error: ${error.slice(0, 200)}`)));

      return;
    }

    const code = url.searchParams.get("code");

    if (!code) {
      response.writeHead(400, CALLBACK_HEADERS);
      response.end("Antigravity sign-in failed: missing code.");

      return;
    }

    response.writeHead(200, CALLBACK_HEADERS);
    response.end("Antigravity sign-in complete. You can close this window and return to Pi.");
    finish(() => settle?.({ code, state }));
  };

  const server: Server = createServer(handler);

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      finish(() =>
        fail?.(
          new Error(
            `Port ${callbackPort()} is already in use. Close the process using it and retry /login antigravity.`,
          ),
        ),
      );

      return;
    }

    finish(() => fail?.(error));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
    server.listen(callbackPort(), "127.0.0.1");
  });

  timer = setTimeout(() => {
    finish(() =>
      fail?.(new Error("Antigravity sign-in timed out waiting for the browser redirect")),
    );
    server.close();
  }, CALLBACK_TIMEOUT_MS);

  return {
    waitForCode: () => codePromise,
    close: () => {
      finish(() => fail?.(new Error("Antigravity sign-in cancelled")));
      server.closeAllConnections?.();
      server.close();
    },
  };
}

/**
 * Validates a callback URL pasted from a browser that cannot reach the loopback listener.
 *
 * @param text - Full callback URL, or a bare `code=…&state=…` query string
 * @param expectedState - State value this flow expects
 * @returns The authorization code
 * @throws If the text is not a valid callback for this flow
 */
export function parsePastedCallback(text: string, expectedState: string): string {
  const trimmed = text.trim();

  if (trimmed === "") {
    throw new Error(
      "Nothing pasted. Paste the full URL from the browser's address bar after signing in.",
    );
  }

  let url: URL;

  try {
    url = new URL(trimmed);
  } catch {
    const query = trimmed.startsWith("?") ? trimmed.slice(1) : trimmed;
    url = new URL(`${redirectUri().split("?")[0]}?${query}`);
  }

  const state = url.searchParams.get("state");

  if (state !== expectedState) {
    throw new Error(
      "The pasted callback belongs to a different sign-in. Run /login antigravity again.",
    );
  }

  const error = url.searchParams.get("error");

  if (error !== null) throw new Error(`Sign-in failed: ${error.slice(0, 200)}`);

  const code = url.searchParams.get("code");

  if (code === null || code === "") {
    throw new Error("The pasted URL is missing `code`. Paste the complete callback URL.");
  }

  return code;
}

/**
 * Resolves the authorization code from the loopback listener or a pasted URL,
 * whichever arrives first.
 *
 * @param expectedState - State value this flow expects
 * @param listener - Running loopback listener
 * @param callbacks - Login interaction surface
 * @returns The verified authorization code
 * @throws If the login is cancelled, times out, or cannot prompt
 */
async function acquireCode(
  expectedState: string,
  listener: CallbackListener,
  callbacks: OAuthLoginCallbacks,
): Promise<string> {
  const abort = new AbortController();

  const pasted = (async (): Promise<string> => {
    let message =
      "If the browser cannot reach this machine, paste the full callback URL from its address bar.";

    while (!abort.signal.aborted) {
      const answer = await callbacks.onPrompt({
        message,
        placeholder: `${DEFAULT_REDIRECT_URI}?state=…&code=…`,
      });

      try {
        return parsePastedCallback(answer, expectedState);
      } catch (error) {
        message = `${error instanceof Error ? error.message : "Invalid callback"} Paste the full URL:`;
      }
    }

    throw new Error("Antigravity sign-in cancelled");
  })();

  const redirected = listener.waitForCode().then(({ code }) => code);

  const aborted = new Promise<never>((_resolve, reject) => {
    const signal = callbacks.signal;

    if (signal === undefined) return;

    if (signal.aborted) {
      reject(new Error("Antigravity sign-in cancelled"));

      return;
    }

    signal.addEventListener("abort", () => reject(new Error("Antigravity sign-in cancelled")), {
      once: true,
    });
  });

  // Losing candidates must not surface as unhandled rejections after the race settles.
  for (const candidate of [pasted, redirected]) candidate.catch(() => {});

  try {
    return await Promise.race([redirected, pasted, aborted]);
  } finally {
    abort.abort();
  }
}

/** Interaction timing for the login flow, injectable for tests. */
export interface LoginTimings {
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
  newState?: () => string;
}

/**
 * Runs the Google sign-in flow and returns credentials ready for storage.
 *
 * @param callbacks - Login interaction surface supplied by Pi
 * @param timings - Clock and randomness overrides for tests
 * @returns Stored credential shape including the discovered project id
 * @throws If the flow is cancelled, the provider refuses, or discovery fails
 */
export async function loginAntigravity(
  callbacks: OAuthLoginCallbacks,
  timings: LoginTimings = {},
): Promise<AntigravityCredentials> {
  // Fail before opening a listener or prompting when the client is not configured.
  if (callbacks.signal?.aborted === true) throw new Error("Antigravity sign-in cancelled");
  const client = await resolveOAuthClient(callbacks.signal);

  const now = timings.now ?? Date.now;
  const random = timings.randomBytes ?? randomBytes;
  const newState = timings.newState ?? randomUUID;
  const pkce = createPkcePair(random);
  const state = newState();
  const listener = await startCallbackListener(state);

  try {
    callbacks.onAuth({
      url: buildAuthUrl(pkce, state, client),
      instructions:
        "Open the link, complete Google sign-in, and return to Pi. If the browser cannot reach this machine, paste the callback URL when prompted.",
    });

    const code = await acquireCode(state, listener, callbacks);
    const tokens = await exchangeCode(code, pkce.verifier, callbacks.signal, client);

    const projectId = await discoverProjectId(tokens.access_token, callbacks.signal);

    return {
      access: tokens.access_token,
      refresh: tokens.refresh_token ?? "",
      expires: expiryFrom(tokens.expires_in, now()),
      projectId,
    };
  } finally {
    listener.close();
  }
}

export { resolveOAuthClient };
