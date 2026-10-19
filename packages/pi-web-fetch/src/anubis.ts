import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { Worker } from "node:worker_threads";
import { parseHTML } from "linkedom";
import { requestFollowingRedirects, type RedirectDependencies } from "./network-redirects";
import type { ValidatedTarget } from "./network-policy";
import { decompressResponse, readResponseBytes, responseHeader } from "./network-transport";
import {
  ANUBIS_MAX_RANDOM_DATA_BYTES,
  ANUBIS_MAX_WASM_BYTES,
  type AnubisWorkerRequest,
  type AnubisSolution,
} from "./anubis-solver";

/** Matches the script markers every Anubis challenge, denial, and error page carries. */
const ANUBIS_SCRIPT_MARKER = /id=["']anubis_(?:challenge|version)["']/i;

/** In-process methods solved by searching a SHA-256 nonce. */
const SHA256_METHODS = new Set(["fast", "slow"]);

/** In-process methods solved by a server-provided WebAssembly module. */
const WASM_METHODS = new Set(["sha256", "hashx", "argon2id"]);

/** Challenge extensions this client performs; anything else is unsupported. */
const SUPPORTED_EXTENSIONS = new Set(["css-load"]);

/** Longest base prefix accepted from a challenge page. */
const MAX_BASE_PREFIX_CHARACTERS = 512;

/** Longest challenge identifier accepted from a challenge page. */
const MAX_CHALLENGE_ID_CHARACTERS = 256;

/** Longest Anubis version string accepted from a challenge page. */
const MAX_VERSION_CHARACTERS = 128;

/** Maximum number of extensions accepted from a challenge page. */
const MAX_EXTENSIONS = 8;

/** Largest passive-method wait, bounding hostile difficulty values. */
const MAX_PASSIVE_DELAY_MS = 15_000;

/** Hard stop for a worker solve; the caller's timeout normally fires first. */
const WORKER_DEADLINE_MS = 60_000;

/** Maximum number of extension stylesheets fetched before a pass attempt. */
const MAX_CSS_ASSETS = 4;

/** Maximum size of one extension stylesheet response. */
const MAX_CSS_ASSET_BYTES = 64 * 1024;

/** A JSON value decoded from an Anubis script tag. */
type AnubisScriptValue =
  | string
  | number
  | boolean
  | null
  | AnubisScriptValue[]
  | AnubisScriptObject;

/** A JSON object decoded from an Anubis script tag. */
interface AnubisScriptObject {
  [key: string]: AnubisScriptValue;
}

/** Pass-challenge query parameters, limited to the fields this client sends. */
interface AnubisPassParameters {
  response?: string;
  nonce?: string;
  result?: string;
  challenge?: string;
}

/** A parsed, bounded Anubis challenge that this client can attempt to solve. */
export interface AnubisChallenge {
  id: string;
  method: string;
  randomData: string;
  difficulty: number;
  version: string;
  basePrefix: string;
  extensions: string[];
}

/** The result of a successful Anubis pass: the response for the original page. */
interface AnubisPassResult {
  target: ValidatedTarget;
  response: IncomingMessage;
}

/** Context required to solve one challenge and continue to the requested page. */
export interface AnubisSolveContext {
  challenge: AnubisChallenge;
  pageUrl: URL;
  raw: string;
  dependencies: RedirectDependencies;
  signal: AbortSignal;
}

/** Creates the consistent abort error used by redirect and retry coordination. */
function abortError(): Error {
  const error = new Error("Operation aborted.");
  error.name = "AbortError";

  return error;
}

/** Returns whether HTML contains Anubis challenge or version script markers. */
export function hasAnubisMarkers(raw: string): boolean {
  return ANUBIS_SCRIPT_MARKER.test(raw);
}

/** Narrows a decoded JSON value to a string. */
function isString(value: AnubisScriptValue | undefined): value is string {
  return typeof value === "string";
}

/** Narrows a decoded JSON value to a finite number. */
function isNumber(value: AnubisScriptValue | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Narrows a decoded JSON value to an object. */
function isScriptObject(value: AnubisScriptValue | undefined): value is AnubisScriptObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrows a decoded JSON value to an array of strings. */
function isStringArray(value: AnubisScriptValue | undefined): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

/** Returns whether a string contains control characters unsafe for header or URL building. */
function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code <= 0x1f || code === 0x7f) return true;
  }

  return false;
}

/**
 * Sanitizes a challenge base prefix into a leading path that stays on the
 * challenge origin and cannot escape it through traversal or encoded segments.
 */
function sanitizeBasePrefix(value: AnubisScriptValue | undefined): string | undefined {
  if (value === undefined) return "";

  if (!isString(value) || value.length > MAX_BASE_PREFIX_CHARACTERS) return undefined;

  if (value === "") return "";

  if (!value.startsWith("/") || value.startsWith("//")) return undefined;

  if (value.includes("\\") || value.includes("?") || value.includes("#") || value.includes("%"))
    return undefined;

  if (hasControlCharacters(value)) return undefined;

  const segments = value.split("/").filter(Boolean);

  if (segments.some((segment) => segment === "." || segment === "..")) return undefined;

  return `/${segments.join("/")}`;
}

/** Decodes one JSON script tag by id, returning undefined when absent or malformed. */
function readJsonScript(
  document: ReturnType<typeof parseHTML>["document"],
  id: string,
): AnubisScriptValue | undefined {
  const element = document.getElementById(id);
  const text = element?.textContent;

  if (!text) return undefined;

  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Returns whether a PublicUrl script names a different origin than the challenge page. */
function isCrossOriginPublicUrl(
  document: ReturnType<typeof parseHTML>["document"],
  pageUrl: URL,
): boolean {
  const value = readJsonScript(document, "anubis_public_url");

  if (!isString(value) || value.length === 0) return false;

  try {
    return new URL(value).origin !== pageUrl.origin;
  } catch {
    // A malformed PublicUrl is ignored; the pass URL is always built from the page origin.
    return false;
  }
}

/**
 * Parses an Anubis challenge page into a solvable challenge.
 *
 * Returns undefined when the page is not an Anubis interstitial, when the
 * challenge payload is malformed, when required metadata is missing, or when
 * `anubis_public_url` names a different origin than the page that served it.
 *
 * @param raw - The decoded HTML of the candidate page.
 * @param pageUrl - The final URL that returned the page.
 * @returns A validated challenge, or undefined when the page is not solvable.
 */
export function parseAnubisChallenge(raw: string, pageUrl: URL): AnubisChallenge | undefined {
  if (!hasAnubisMarkers(raw)) return undefined;

  const { document } = parseHTML(raw);
  const version = readJsonScript(document, "anubis_version");
  const challengePayload = readJsonScript(document, "anubis_challenge");

  if (!isString(version) || version.length === 0 || version.length > MAX_VERSION_CHARACTERS)
    return undefined;

  if (isCrossOriginPublicUrl(document, pageUrl)) return undefined;

  if (!isScriptObject(challengePayload)) return undefined;

  const basePrefix = sanitizeBasePrefix(readJsonScript(document, "anubis_base_prefix"));

  if (basePrefix === undefined) return undefined;

  const challenge = challengePayload.challenge;

  if (!isScriptObject(challenge)) return undefined;

  const rulesValue = challengePayload.rules;
  const rules = isScriptObject(rulesValue) ? rulesValue : undefined;
  const id = challenge.id;
  const rawMethod = challenge.method;
  const ruleMethod = rules?.algorithm;

  const method =
    isString(rawMethod) && rawMethod.length > 0
      ? rawMethod
      : isString(ruleMethod)
        ? ruleMethod
        : undefined;

  const difficulty = isNumber(challenge.difficulty) ? challenge.difficulty : rules?.difficulty;
  const randomData = challenge.randomData;
  const rawExtensions = challenge.extensions;

  if (!isString(id) || id.length === 0 || id.length > MAX_CHALLENGE_ID_CHARACTERS) return undefined;

  if (hasControlCharacters(id)) return undefined;

  if (!isString(method) || method.length === 0 || method.length > MAX_CHALLENGE_ID_CHARACTERS)
    return undefined;

  if (hasControlCharacters(method)) return undefined;

  if (
    !isNumber(difficulty) ||
    !Number.isInteger(difficulty) ||
    difficulty < 0 ||
    difficulty > 0xffff_ffff
  ) {
    return undefined;
  }

  if (
    !isString(randomData) ||
    randomData.length === 0 ||
    randomData.length > ANUBIS_MAX_RANDOM_DATA_BYTES * 2 ||
    hasControlCharacters(randomData)
  ) {
    return undefined;
  }

  const extensions = rawExtensions === undefined ? [] : rawExtensions;

  if (!isStringArray(extensions) || extensions.length > MAX_EXTENSIONS) return undefined;

  if (extensions.some((extension) => extension.length === 0 || extension.length > 64))
    return undefined;

  return { id, method, randomData, difficulty, version, basePrefix, extensions };
}

/** Returns whether every extension declared by a challenge is supported. */
function hasSupportedExtensions(challenge: AnubisChallenge): boolean {
  return challenge.extensions.every((extension) => SUPPORTED_EXTENSIONS.has(extension));
}

/** Hashes a string with SHA-256, returning lowercase hexadecimal. */
function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Waits for a bounded delay while remaining cancellable. */
function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
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

/** Computes the passive wait for `preact` and `metarefresh`, bounded against hostile input. */
function passiveDelay(difficulty: number, perUnitMs: number, marginMs: number): number {
  return Math.min(difficulty * perUnitMs + marginMs, MAX_PASSIVE_DELAY_MS);
}

/** A message posted from the solve worker back to the parent. */
type AnubisWorkerMessage =
  | { kind: "solved"; solution: AnubisSolution }
  | { kind: "error"; message: string };

/** Runs one solve request in a sandboxed worker thread, terminating it on abort. */
function solveInWorker(request: AnubisWorkerRequest, signal: AbortSignal): Promise<AnubisSolution> {
  const worker = new Worker(new URL("./anubis-worker.ts", import.meta.url), {
    workerData: request,
    resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
  });

  return new Promise<AnubisSolution>((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
      worker.removeAllListeners();
    };

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };

    const onAbort = (): void => {
      void worker.terminate();
      finish(() => reject(abortError()));
    };

    worker.on("message", (message: AnubisWorkerMessage) => {
      if (message.kind === "solved") finish(() => resolve(message.solution));
      else finish(() => reject(new Error(message.message)));
    });

    worker.on("error", (error) => finish(() => reject(error)));
    worker.on("exit", (code) => {
      if (code !== 0)
        finish(() => reject(new Error(`Anubis solve worker exited with code ${code}.`)));
    });

    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Fetches the WebAssembly module for a `sha256`, `hashx`, or `argon2id` challenge. */
async function fetchWasmModule(
  method: string,
  challenge: AnubisChallenge,
  pageUrl: URL,
  dependencies: RedirectDependencies,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const asset = new URL(
    `${challenge.basePrefix}/.within.website/x/cmd/anubis/static/wasm/baseline/${method}.wasm`,
    pageUrl.origin,
  );

  asset.searchParams.set("cacheBuster", challenge.version);
  const { response } = await requestFollowingRedirects(asset, signal, dependencies);
  const status = response.statusCode ?? 0;

  if (status < 200 || status >= 300) {
    response.resume();
    throw new Error(`web_fetch could not download the Anubis challenge module (HTTP ${status}).`);
  }

  const bytes = await readResponseBytes(response, ANUBIS_MAX_WASM_BYTES, signal);
  const decoded = decompressResponse(bytes, responseHeader(response, "content-encoding"));

  if (decoded.byteLength === 0 || decoded.byteLength > ANUBIS_MAX_WASM_BYTES)
    throw new Error("Anubis challenge module exceeded the size limit.");

  return decoded;
}

/** Extracts same-origin stylesheet URLs injected by the `css-load` extension. */
function cssLoadUrls(raw: string, pageUrl: URL): URL[] {
  const { document } = parseHTML(raw);
  const urls: URL[] = [];
  const seen = new Set<string>();

  const consider = (candidate: string | null | undefined): void => {
    if (!candidate || urls.length >= MAX_CSS_ASSETS) return;
    let url: URL;

    try {
      url = new URL(candidate, pageUrl);
    } catch {
      return;
    }

    if (!["http:", "https:"].includes(url.protocol)) return;

    if (url.username || url.password) return;

    if (url.origin !== pageUrl.origin) return;

    if (seen.has(url.href)) return;

    seen.add(url.href);
    urls.push(url);
  };

  for (const element of document.querySelectorAll("style")) {
    const css = element.textContent ?? "";
    const matches = css.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)/gi);

    for (const match of matches) consider(match[1]);
  }

  for (const element of document.querySelectorAll("link[rel=stylesheet][href]"))
    consider(element.getAttribute("href"));

  return urls;
}

/** Performs the `css-load` extension requests so the server records the verification handshake. */
async function performCssLoad(
  raw: string,
  pageUrl: URL,
  dependencies: RedirectDependencies,
  signal: AbortSignal,
): Promise<void> {
  const urls = cssLoadUrls(raw, pageUrl);

  await Promise.all(
    urls.map(async (url) => {
      try {
        const { response } = await requestFollowingRedirects(url, signal, dependencies);

        await readResponseBytes(response, MAX_CSS_ASSET_BYTES, signal);
      } catch (error) {
        if (signal.aborted) throw error;
      }
    }),
  );
}

/**
 * Solves an Anubis challenge and returns the response for the originally
 * requested page.
 *
 * Every challenge request travels through the same validation, DNS pinning,
 * redirect, and concurrency path as a normal fetch, and uses only the cookie jar
 * attached to the current acquisition.
 *
 * @param context - The parsed challenge, page URL, dependencies, and abort signal.
 * @returns The final target and response after a successful pass.
 * @throws When the method or an extension is unsupported, the method's solve fails, or the signal aborts.
 */
export async function solveAnubisChallenge(context: AnubisSolveContext): Promise<AnubisPassResult> {
  const { challenge, pageUrl, raw, dependencies, signal } = context;
  const started = Date.now();

  if (!hasSupportedExtensions(challenge))
    throw new Error("web_fetch does not support the extensions required by this Anubis challenge.");

  if (challenge.extensions.includes("css-load"))
    await performCssLoad(raw, pageUrl, dependencies, signal);

  const deadline = Date.now() + WORKER_DEADLINE_MS;
  let params: AnubisPassParameters;

  if (SHA256_METHODS.has(challenge.method)) {
    const solution = await solveInWorker(
      {
        kind: "sha256",
        randomData: challenge.randomData,
        difficulty: challenge.difficulty,
        deadline,
      },
      signal,
    );

    params = { response: solution.hash, nonce: String(solution.nonce) };
  } else if (WASM_METHODS.has(challenge.method)) {
    const moduleBytes = await fetchWasmModule(
      challenge.method,
      challenge,
      pageUrl,
      dependencies,
      signal,
    );

    const solution = await solveInWorker(
      {
        kind: "wasm",
        moduleBytes,
        randomData: challenge.randomData,
        difficulty: challenge.difficulty,
        deadline,
      },
      signal,
    );

    params = { response: solution.hash, nonce: String(solution.nonce) };
  } else if (challenge.method === "preact") {
    await delay(passiveDelay(challenge.difficulty, 125, 100), signal);
    params = { result: sha256Hex(challenge.randomData) };
  } else if (challenge.method === "metarefresh") {
    await delay(passiveDelay(challenge.difficulty, 800, 250), signal);
    params = { challenge: challenge.randomData };
  } else {
    throw new Error(
      `web_fetch does not support the Anubis "${challenge.method}" challenge method.`,
    );
  }

  const passUrl = new URL(
    `${challenge.basePrefix}/.within.website/x/cmd/anubis/api/pass-challenge`,
    pageUrl.origin,
  );

  passUrl.searchParams.set("id", challenge.id);
  passUrl.searchParams.set("redir", pageUrl.href);
  passUrl.searchParams.set("elapsedTime", String(Math.max(1, Date.now() - started)));

  for (const [key, value] of Object.entries(params)) passUrl.searchParams.set(key, value);

  return requestFollowingRedirects(passUrl, signal, dependencies);
}
