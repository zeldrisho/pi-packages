import { createCipheriv, randomBytes, randomInt, randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import type { AwsWafWork } from "./aws-waf-solver.ts";
import type { IncomingMessage } from "node:http";
import { crc32 } from "node:zlib";
import type { AwsWafResolveContext, AwsWafResolver, AwsWafSolution } from "./aws-waf.ts";
import { CookieJar } from "../network/cookies.ts";
import {
  requestFollowingRedirects,
  type RedirectDependencies,
} from "../network/network-redirects.ts";
import { validateRemoteUrl } from "../network/network-policy.ts";
import {
  FETCH_MAX_BYTES,
  decodeResponse,
  decompressResponse,
  readResponseBytes,
  requestPinned,
  responseHeader,
} from "../network/network-transport.ts";

/** AWS WAF browser-challenge signal encryption key used by the current challenge family. */
const SIGNAL_KEY = Buffer.from(
  "6f71a512b1e035eaab53d8be73120d3fb68a0ca346b9560aab3e5cdf753d5e98",
  "hex",
);

/** Browser identity used for the challenge handshake and the retry. */
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36";

const BROWSER_VERSION = "144";

const SCREEN = "1920-1080-1080-24-*-*-*";

const PLUGINS = [
  { name: "PDF Viewer", str: "PDF Viewer " },
  { name: "Chrome PDF Viewer", str: "Chrome PDF Viewer " },
  { name: "Chromium PDF Viewer", str: "Chromium PDF Viewer " },
  { name: "Microsoft Edge PDF Viewer", str: "Microsoft Edge PDF Viewer " },
  { name: "WebKit built-in PDF", str: "WebKit built-in PDF " },
];

const PLUGIN_STRING = PLUGINS.map((plugin) => plugin.str).join("");

const MATH_VALUES = {
  tan: "-1.4214488238747245",
  sin: "0.8178819121159085",
  cos: "-0.5753861119575491",
};

const GPU_EXTENSIONS = [
  "ANGLE_instanced_arrays",
  "EXT_blend_minmax",
  "EXT_clip_control",
  "EXT_color_buffer_half_float",
  "EXT_depth_clamp",
  "EXT_disjoint_timer_query",
  "EXT_float_blend",
  "EXT_frag_depth",
  "EXT_polygon_offset_clamp",
  "EXT_shader_texture_lod",
  "EXT_texture_compression_bptc",
  "EXT_texture_compression_rgtc",
  "EXT_texture_filter_anisotropic",
  "EXT_texture_mirror_clamp_to_edge",
  "EXT_sRGB",
  "KHR_parallel_shader_compile",
  "OES_element_index_uint",
  "OES_fbo_render_mipmap",
  "OES_standard_derivatives",
  "OES_texture_float",
  "OES_texture_float_linear",
  "OES_texture_half_float",
  "OES_texture_half_float_linear",
  "OES_vertex_array_object",
  "WEBGL_blend_func_extended",
  "WEBGL_color_buffer_float",
  "WEBGL_compressed_texture_astc",
  "WEBGL_compressed_texture_etc",
  "WEBGL_compressed_texture_etc1",
  "WEBGL_compressed_texture_s3tc",
  "WEBGL_compressed_texture_s3tc_srgb",
  "WEBGL_debug_renderer_info",
  "WEBGL_debug_shaders",
  "WEBGL_depth_texture",
  "WEBGL_lose_context",
  "WEBGL_multi_draw",
  "WEBGL_polygon_mode",
];

/** Maps challenge type hashes to their proof-of-work family. */
function normalizeChallengeType(value: string): string {
  if (value.startsWith("ha9faaffd")) return "NetworkBandwidth";

  if (value.startsWith("h72f957df")) return "HashcashScrypt";

  if (value.startsWith("h7b0c470f")) return "SHA256";

  return value;
}

/** Returns the submission endpoint for a challenge type. */
function challengeEndpoint(challengeType: string): string {
  return challengeType === "NetworkBandwidth" ? "mp_verify" : "verify";
}

const CHALLENGE_SAME_ORIGIN = /(\/__challenge_[A-Za-z0-9]+\/[a-f0-9]+\/[a-f0-9]+)/;

const CHALLENGE_EXTERNAL =
  /(https:\/\/[a-z0-9]+\.[a-z0-9]+\.[a-z0-9-]+\.token\.awswaf\.com\/[^/\s"]+\/[^/\s"]+\/[^/\s"]+)/;

const CHALLENGE_SDK =
  /(https:\/\/[a-z0-9]+\.edge\.sdk\.awswaf\.com\/[a-z0-9]+\/[a-z0-9]+)\/challenge\.js/;

const GOKU_PROPS = /window\.gokuProps\s*=\s*(\{[^}]+\})/;

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type JsonObject = { [key: string]: JsonValue };

interface TextResponse {
  url: URL;
  status: number;
  text: string;
}

interface FingerprintMetrics {
  fp2: number;
  browser: number;
  capabilities: number;
  gpu: number;
  dnt: number;
  math: number;
  screen: number;
  navigator: number;
  auto: number;
  stealth: number;
  subtle: number;
  canvas: number;
  formdetector: number;
  be: number;
}

interface Collector {
  name: keyof FingerprintMetrics;
  metric: string;
  low: number;
  high: number;
}

const COLLECTORS: readonly Collector[] = [
  { name: "fp2", metric: "100", low: 0.5, high: 3 },
  { name: "browser", metric: "101", low: 0, high: 1 },
  { name: "capabilities", metric: "102", low: 2, high: 8 },
  { name: "gpu", metric: "103", low: 3, high: 12 },
  { name: "dnt", metric: "104", low: 0, high: 1 },
  { name: "math", metric: "105", low: 0, high: 1 },
  { name: "screen", metric: "106", low: 0, high: 1 },
  { name: "navigator", metric: "107", low: 0, high: 1 },
  { name: "auto", metric: "108", low: 0, high: 1 },
  { name: "stealth", metric: "undefined", low: 1, high: 4 },
  { name: "subtle", metric: "110", low: 0, high: 1 },
  { name: "canvas", metric: "111", low: 80, high: 200 },
  { name: "formdetector", metric: "112", low: 0, high: 3 },
  { name: "be", metric: "undefined", low: 0, high: 1 },
];

interface ChallengeData {
  input: string;
  hmac?: string;
  region?: string;
}

interface ChallengeInputs {
  challenge: ChallengeData;
  challengeType: string;
  difficulty: number;
  memory: number;
}

interface BuiltMetrics {
  metrics: JsonValue[];
  fingerprint: FingerprintMetrics;
}

/** Returns whether a value is a plain JSON object. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- parses untrusted challenge JSON at the I/O boundary
function isJsonObject(value: unknown): value is JsonObject {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validates untrusted challenge JSON before use
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses untrusted JSON text into a plain object. */
function parseJsonObject(text: string): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(text);

    return isJsonObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Reads a string field, returning undefined for missing or non-string values. */
function stringField(value: JsonObject, key: string): string | undefined {
  const field = value[key];

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validates an untrusted JSON field
  return typeof field === "string" ? field : undefined;
}

/** Reads a numeric field, returning undefined for missing or non-numeric values. */
function numberField(value: JsonObject, key: string): number | undefined {
  const field = value[key];

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validates an untrusted JSON field
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

/** Returns a random floating-point metric in the supplied range. */
function randomMetric(low: number, high: number): number {
  return Math.round((low + Math.random() * (high - low)) * 10) / 10;
}

/** Builds realistic-looking WAF metrics and the matching fingerprint metric map. */
function buildMetrics(hasToken: boolean): BuiltMetrics {
  const fingerprint: FingerprintMetrics = {
    fp2: 0,
    browser: 0,
    capabilities: 0,
    gpu: 0,
    dnt: 0,
    math: 0,
    screen: 0,
    navigator: 0,
    auto: 0,
    stealth: 0,
    subtle: 0,
    canvas: 0,
    formdetector: 0,
    be: 0,
  };

  const metrics: JsonValue[] = [];

  for (const collector of COLLECTORS) {
    const value = randomMetric(collector.low, collector.high);

    fingerprint[collector.name] = Math.trunc(value);
    metrics.push({ name: collector.metric, value, unit: "2" });
  }

  const encoding = randomMetric(0.5, 3);
  const encryption = randomMetric(2, 8);

  const acquisition =
    COLLECTORS.reduce((total, collector) => total + fingerprint[collector.name], 0) +
    encoding +
    encryption +
    randomMetric(2, 6);

  const challenge = randomMetric(2, 8);
  const cookie = randomMetric(0.1, 1);
  const total = acquisition + challenge + cookie;

  metrics.push(
    { name: "2", value: encoding, unit: "2" },
    { name: "3", value: encryption, unit: "2" },
    { name: "7", value: hasToken ? 1 : 0, unit: "4" },
    { name: "1", value: acquisition, unit: "2" },
    { name: "4", value: challenge, unit: "2" },
    { name: "5", value: cookie, unit: "2" },
    { name: "6", value: total, unit: "2" },
    { name: "8", value: 1, unit: "4" },
  );

  return { metrics, fingerprint };
}

/** Builds a browser fingerprint object accepted by the WAF signal decoder. */
function buildSignal(site: string, fingerprint: FingerprintMetrics) {
  const now = Date.now();
  const canvasHash = randomInt(100_000_000, 1_000_000_000);
  const histogram = Array.from({ length: 256 }, () => randomInt(1, 50));

  return {
    metrics: { ...fingerprint },
    start: now,
    flashVersion: null,
    plugins: PLUGINS.map((plugin) => ({ name: plugin.name, str: plugin.str })),
    dupedPlugins: `${PLUGIN_STRING}||${SCREEN}`,
    screenInfo: SCREEN,
    referrer: "",
    userAgent: BROWSER_USER_AGENT,
    location: `${site}/`,
    webDriver: false,
    capabilities: {
      css: {
        textShadow: 1,
        WebkitTextStroke: 1,
        boxShadow: 1,
        borderRadius: 1,
        borderImage: 1,
        opacity: 1,
        transform: 1,
        transition: 1,
      },
      js: {
        audio: true,
        geolocation: true,
        localStorage: "supported",
        touch: false,
        video: true,
        webWorker: true,
      },
      elapsed: fingerprint.capabilities,
    },
    gpu: {
      vendor: "Google Inc. (NVIDIA Corporation)",
      model: "ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 5070/PCIe/SSE2, OpenGL ES 3.2)",
      extensions: GPU_EXTENSIONS,
    },
    dnt: null,
    math: MATH_VALUES,
    automation: {
      wd: { properties: { document: [], window: [], navigator: [] } },
      phantom: { properties: { window: [] } },
    },
    stealth: { t1: 0, t2: 0, i: 1, mte: 0, mtd: false },
    crypto: {
      crypto: 1,
      subtle: 1,
      encrypt: true,
      decrypt: true,
      wrapKey: true,
      unwrapKey: true,
      sign: true,
      verify: true,
      digest: true,
      deriveBits: true,
      deriveKey: true,
      getRandomValues: true,
      randomUUID: true,
    },
    canvas: { hash: canvasHash, emailHash: null, histogramBins: histogram },
    formDetected: false,
    numForms: 0,
    numFormElements: 0,
    be: { si: false },
    end: now + 1,
    errors: [],
    version: "2.4.0",
    id: randomUUID(),
  };
}

/** Builds and encrypts the browser signal payload. */
function encodeSignal(site: string, hasToken: boolean) {
  const built = buildMetrics(hasToken);
  const signal = buildSignal(site, built.fingerprint);
  const plaintextJson = JSON.stringify(signal);
  const checksum = crc32(plaintextJson).toString(16).toUpperCase().padStart(8, "0");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", SIGNAL_KEY, iv);

  const ciphertext = Buffer.concat([
    cipher.update(`${checksum}#${plaintextJson}`, "utf8"),
    cipher.final(),
  ]);

  const tag = cipher.getAuthTag();

  return {
    encrypted: `${iv.toString("base64")}::${tag.toString("hex")}::${ciphertext.toString("hex")}`,
    checksum,
    metrics: built.metrics,
    signal,
  };
}

/** Builds the signal entry used in challenge submissions. */
function signalEntry(encrypted: string): JsonValue[] {
  return [{ name: "Zoey", value: { Present: encrypted } }];
}

/** Run CPU-intensive work off the main thread and terminate it on cancellation. */
function solveAwsWafChallenge(
  inputs: ChallengeInputs,
  checksum: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  signal.throwIfAborted();

  const work: AwsWafWork = {
    type: inputs.challengeType,
    input: inputs.challenge.input,
    checksum,
    difficulty: inputs.difficulty,
    memory: inputs.memory,
  };

  const worker = new Worker(new URL("../../workers/aws-waf-worker.js", import.meta.url), {
    workerData: work,
    resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
  });

  return new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(
      () => finish(() => reject(new Error("AWS WAF worker timed out."))),
      60_000,
    );

    function finish(callback: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      void worker.terminate();
      callback();
    }

    function onAbort(): void {
      finish(() => reject(signal.reason));
    }

    worker.on(
      "message",
      (message: { kind: "solved"; solution?: string } | { kind: "error"; message: string }) => {
        if (message.kind === "solved") finish(() => resolve(message.solution));
        else finish(() => reject(new Error(message.message)));
      },
    );
    worker.on("error", (error) => finish(() => reject(error)));
    worker.on("exit", (code) =>
      finish(() => reject(new Error(`AWS WAF worker exited with code ${code}.`))),
    );

    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Parses the base64 challenge input into challenge metadata. */
function decodeChallengeInput(input: string): JsonObject | undefined {
  try {
    return parseJsonObject(Buffer.from(input, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

/** Reads challenge inputs from the `/inputs` response. */
function parseChallengeInputs(value: JsonObject): ChallengeInputs | undefined {
  const challenge = value["challenge"];

  if (!isJsonObject(challenge)) return undefined;

  const input = stringField(challenge, "input");

  if (!input) return undefined;

  const decoded = decodeChallengeInput(input);

  const challengeType =
    (decoded ? stringField(decoded, "challenge_type") : undefined) ??
    stringField(value, "challenge_type");

  if (!challengeType) return undefined;

  const difficulty =
    (decoded ? numberField(decoded, "difficulty") : undefined) ??
    numberField(value, "difficulty") ??
    1;

  const memory =
    (decoded ? numberField(decoded, "memory") : undefined) ?? numberField(value, "memory") ?? 128;

  return {
    challenge: {
      input,
      hmac: stringField(challenge, "hmac"),
      region: stringField(challenge, "region"),
    },
    challengeType: normalizeChallengeType(challengeType),
    difficulty,
    memory,
  };
}

/** Extracts the challenge URL and goku properties from a WAF page. */
export function extractAwsWafChallenge(
  html: string,
  site: URL,
): { challengeUrl: string; gokuProps?: JsonObject } | undefined {
  const sameOrigin = CHALLENGE_SAME_ORIGIN.exec(html);
  const external = CHALLENGE_EXTERNAL.exec(html);
  const sdk = CHALLENGE_SDK.exec(html);
  const match = sameOrigin ?? external ?? sdk;

  if (!match) return undefined;

  const challengeUrl = sameOrigin ? new URL(match[1], site).href : external ? match[1] : match[1];
  const gokuMatch = GOKU_PROPS.exec(html);
  const gokuProps = gokuMatch ? parseJsonObject(gokuMatch[1]) : undefined;

  return { challengeUrl, gokuProps };
}

/** Builds the browser headers used to request the protected page. */
function browserHeaders() {
  return {
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "accept-language": "en-US,en;q=0.9",
    "sec-ch-ua": `"Not:A-Brand";v="8", "Chromium";v="${BROWSER_VERSION}", "Google Chrome";v="${BROWSER_VERSION}"`,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1",
  };
}

/** Builds the headers used for challenge API calls. */
function apiHeaders(site: string) {
  return {
    accept: "*/*",
    "accept-language": "en-US,en;q=0.9",
    "cache-control": "no-cache",
    origin: site,
    pragma: "no-cache",
    priority: "u=1, i",
    referer: `${site}/`,
    "sec-ch-ua": `"Not:A-Brand";v="8", "Chromium";v="${BROWSER_VERSION}", "Google Chrome";v="${BROWSER_VERSION}"`,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "cross-site",
  };
}

/** Reads and decodes a bounded response body. */
async function readText(response: IncomingMessage, signal: AbortSignal): Promise<string> {
  const bytes = await readResponseBytes(response, FETCH_MAX_BYTES, signal);
  const decompressed = decompressResponse(bytes, responseHeader(response, "content-encoding"));

  return decodeResponse(decompressed, responseHeader(response, "content-type") ?? "text/plain");
}

/** Performs a GET through the validated redirect and cookie boundary. */
async function getText(
  url: string,
  network: RedirectDependencies,
  signal: AbortSignal,
  headers: Readonly<Record<string, string>>,
): Promise<TextResponse> {
  const { target, response } = await requestFollowingRedirects(url, signal, network, headers);
  const text = await readText(response, signal);

  return { url: target.url, status: response.statusCode ?? 0, text };
}

/** Performs a POST to a validated target without following redirects. */
async function postText(
  url: string,
  network: RedirectDependencies,
  signal: AbortSignal,
  headers: Readonly<Record<string, string>>,
  body: string,
): Promise<TextResponse> {
  const validateUrl = network.validateUrl ?? validateRemoteUrl;
  const target = await validateUrl(url);
  const cookieHeader = network.cookies?.headerFor(target.url);

  const requestHeaders = { ...headers };

  if (network.userAgent) requestHeaders["User-Agent"] = network.userAgent;

  if (cookieHeader) requestHeaders.Cookie = cookieHeader;

  const request =
    network.request ??
    ((value, requestSignal, requestHeadersInit, options) =>
      requestPinned(value, requestSignal, {
        headers: requestHeadersInit,
        method: options?.method,
        body: options?.body,
      }));

  const response = await request(target, signal, requestHeaders, { method: "POST", body });
  const text = await readText(response, signal);

  return { url: target.url, status: response.statusCode ?? 0, text };
}

/** Builds the multipart body used by bandwidth challenges. */
function buildMultipart(
  domain: string,
  challenge: ChallengeData,
  solution: string,
  checksum: string,
  encrypted: string,
  metrics: JsonValue[],
  gokuProps: JsonObject | undefined,
) {
  const boundary = `----WebKitFormBoundary${randomBytes(16).toString("hex")}`;

  const metadata = {
    challenge: {
      input: challenge.input,
      hmac: challenge.hmac ?? null,
      region: challenge.region ?? null,
    },
    solution: null,
    signals: signalEntry(encrypted),
    checksum,
    existing_token: null,
    client: "Browser",
    domain,
    metrics,
    goku_props: gokuProps ?? null,
  };

  const body = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="solution_data"',
    "",
    solution,
    `--${boundary}`,
    'Content-Disposition: form-data; name="solution_metadata"',
    "",
    JSON.stringify(metadata),
    `--${boundary}--`,
    "",
  ].join("\r\n");

  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Builds the JSON body used by verify challenges. */
function buildVerificationPayload(
  domain: string,
  challenge: ChallengeData,
  solution: string,
  checksum: string,
  encrypted: string,
  metrics: JsonValue[],
  existingToken: string | undefined,
  gokuProps: JsonObject | undefined,
) {
  return {
    challenge: {
      input: challenge.input,
      hmac: challenge.hmac ?? null,
      region: challenge.region ?? null,
    },
    solution,
    signals: signalEntry(encrypted),
    checksum,
    existing_token: existingToken ?? null,
    client: "Browser",
    domain,
    metrics,
    goku_props: gokuProps ?? null,
  };
}

/** Reads a token from a challenge response, including nested response objects. */
function parseToken(value: JsonObject): string | undefined {
  const direct = stringField(value, "token");

  if (direct) return direct;

  const nested = value["response"];

  return isJsonObject(nested) ? stringField(nested, "token") : undefined;
}

/** Reads replacement challenge inputs from a challenge response. */
function parseReplacementInputs(value: JsonObject): ChallengeInputs | undefined {
  const nested = value["response"];

  if (isJsonObject(nested)) {
    const inputs = nested["inputs"];

    if (isJsonObject(inputs)) return parseChallengeInputs(inputs);
  }

  const inputs = value["inputs"];

  return isJsonObject(inputs) ? parseChallengeInputs(inputs) : undefined;
}

/** Runs the native AWS WAF challenge flow and returns a token. */
async function resolveAwsWafNative(
  context: AwsWafResolveContext,
): Promise<AwsWafSolution | undefined> {
  const network: RedirectDependencies = {
    ...context.network,
    userAgent: BROWSER_USER_AGENT,
    persistentHeaders: browserHeaders(),
    cookies: context.network?.cookies ?? new CookieJar(),
  };

  const site = context.url.origin;
  const domain = context.url.hostname;

  const page = await getText(context.url.href, network, context.signal, browserHeaders());

  if (page.status !== 200 && page.status !== 202) return undefined;

  const discovery = extractAwsWafChallenge(page.text, context.url);

  if (!discovery) return undefined;

  const inputsResponse = await getText(
    `${discovery.challengeUrl}/inputs?client=browser`,
    network,
    context.signal,
    apiHeaders(site),
  );

  if (inputsResponse.status !== 200) return undefined;

  let inputs = parseChallengeInputs(parseJsonObject(inputsResponse.text) ?? {});

  if (!inputs) return undefined;

  let token: string | undefined;

  for (let round = 0; round < 2; round += 1) {
    const signal = encodeSignal(site, token !== undefined);
    const solution = await solveAwsWafChallenge(inputs, signal.checksum, context.signal);

    if (!solution) return undefined;

    const endpoint = challengeEndpoint(inputs.challengeType);
    let body: string;
    let contentType = "text/plain;charset=UTF-8";

    if (endpoint === "mp_verify") {
      const multipart = buildMultipart(
        domain,
        inputs.challenge,
        solution,
        signal.checksum,
        signal.encrypted,
        signal.metrics,
        discovery.gokuProps,
      );

      body = multipart.body;
      contentType = multipart.contentType;
    } else {
      body = JSON.stringify(
        buildVerificationPayload(
          domain,
          inputs.challenge,
          solution,
          signal.checksum,
          signal.encrypted,
          signal.metrics,
          token,
          discovery.gokuProps,
        ),
      );
    }

    const headers = { ...apiHeaders(site), "content-type": contentType };

    const response = await postText(
      `${discovery.challengeUrl}/${endpoint}`,
      network,
      context.signal,
      headers,
      body,
    );

    if (response.status !== 200) return undefined;

    const parsed = parseJsonObject(response.text);

    if (!parsed) return undefined;

    token = parseToken(parsed) ?? token;

    if (token) break;

    const replacement = parseReplacementInputs(parsed);

    if (replacement) inputs = replacement;
  }

  return token ? { token, userAgent: BROWSER_USER_AGENT } : undefined;
}

/** Native in-process AWS WAF resolver. */
export const nativeAwsWafResolver: AwsWafResolver = {
  resolve: resolveAwsWafNative,
};
