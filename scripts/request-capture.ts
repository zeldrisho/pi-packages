import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const MAX_BODY_SAMPLES = 32;

const MAX_SAMPLE_BYTES = 256;

const MAX_HEADER_VALUE_BYTES = 256;

const MAX_EVENTS = 128;

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
  "api-key",
]);

const SENSITIVE_BODY_KEYS = new Set([
  "authorization",
  "access_token",
  "refresh_token",
  "id_token",
  "api_key",
  "apiKey",
  "token",
  "secret",
  "password",
  "code",
  "code_verifier",
  "client_secret",
  "clientSecret",
]);

const OPAQUE_QUERY_KEYS = new Set([
  "code",
  "state",
  "key",
  "token",
  "access_token",
  "refresh_token",
  "api_key",
  "apikey",
  "client_secret",
  "clientsecret",
  "signature",
  "sig",
]);

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface EvidencePayload {
  question?: string;
  observed: readonly string[];
  inferred: readonly string[];
  unknown: readonly string[];
}

export interface RequestCapture {
  schema: 1;
  events: readonly RequestEvent[];
}

export interface RequestEvent {
  kind: "request" | "response" | "error";
  method: string;
  target: string;
  status?: number;
  headers: Readonly<Record<string, string>>;
  body: Json;
  at: string;
}

export interface CaptureSink {
  fetch: typeof fetch;
  snapshot: () => RequestCapture;
  clear: () => void;
}

interface RecordedBody {
  fields: string[];
  sample: string;
  truncated: boolean;
}

interface UnknownPayload {
  readonly question?: string;
  readonly observed?: readonly string[];
  readonly inferred?: readonly string[];
  readonly unknown?: readonly string[];
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isBodyString(value: BodyInit | null | undefined): value is string {
  return typeof value === "string";
}

function isUrlString(value: RequestInfo | URL): value is string {
  return typeof value === "string";
}

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isString);
}

function isJson(value: Json): value is { [key: string]: Json } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonString(value: Json): value is string {
  return typeof value === "string";
}

function parseJson(text: string): Json {
  if (text.length === 0) return null;

  try {
    const value: unknown = JSON.parse(text);

    return isJsonValue(value) ? value : { type: "non-object-json" };
  } catch {
    return { type: "non-json" };
  }
}

function isJsonValue(value: unknown): value is Json {
  if (value === null || typeof value === "boolean" || typeof value === "number") return true;

  if (typeof value === "string") return value.length <= MAX_SAMPLE_BYTES;

  if (Array.isArray(value)) return value.length <= MAX_BODY_SAMPLES && value.every(isJsonValue);

  if (value === null || typeof value !== "object") return false;
  const entries = Object.entries(Object(value));

  return (
    entries.length <= MAX_BODY_SAMPLES &&
    entries.every(([key, item]) => key.length <= MAX_SAMPLE_BYTES && isJsonValue(item))
  );
}

function sanitizeJson(value: Json): Json {
  if (Array.isArray(value)) return value.slice(0, MAX_BODY_SAMPLES).map(sanitizeJson);

  if (isJson(value)) {
    const result: { [key: string]: Json } = {};
    let count = 0;

    for (const [key, item] of Object.entries(value)) {
      if (count === MAX_BODY_SAMPLES) break;
      count += 1;
      result[key] = SENSITIVE_BODY_KEYS.has(key) ? "[redacted]" : sanitizeJson(item);
    }

    return result;
  }

  if (isJsonString(value) && value.length > MAX_SAMPLE_BYTES)
    return { length: value.length, sha256: createHash("sha256").update(value).digest("hex") };

  return value;
}

function redactedJson(value: Json): Json {
  const sanitized = sanitizeJson(value);

  return isJson(sanitized) ? sanitized : { value: sanitized };
}

async function describeBody(body: BodyInit | null | undefined): Promise<RecordedBody> {
  if (body === null || body === undefined) return { fields: [], sample: "none", truncated: false };

  if (!isBodyString(body) && !ArrayBuffer.isView(body) && !(body instanceof ArrayBuffer))
    return { fields: [], sample: "stream", truncated: false };

  if (isBodyString(body)) {
    const parsed = redactedJson(parseJson(body));

    return {
      fields: isJson(parsed)
        ? Object.keys(parsed)
            .filter((key) => !SENSITIVE_BODY_KEYS.has(key))
            .slice(0, MAX_BODY_SAMPLES)
        : [],
      sample: JSON.stringify(parsed),
      truncated: body.length > MAX_SAMPLE_BYTES,
    };
  }

  return { fields: [], sample: "binary", truncated: false };
}

function targetOf(input: RequestInfo | URL): string {
  const raw = isUrlString(input) ? input : input instanceof URL ? input.toString() : input.url;

  try {
    const url = new URL(raw);

    for (const key of url.searchParams.keys()) {
      if (OPAQUE_QUERY_KEYS.has(key.toLowerCase())) url.searchParams.set(key, "[redacted]");
    }

    return `${url.origin}${url.pathname}${url.search}`;
  } catch {
    return "[invalid-target]";
  }
}

function headerNames(headers: HeadersInit | undefined): readonly string[] {
  if (headers === undefined) return [];

  if (Array.isArray(headers)) return headers.map(([name]) => name);

  if (headers instanceof Headers) return [...headers.keys()];

  return Object.keys(headers);
}

function headerValue(headers: Headers, name: string): string {
  const raw = headers.get(name) ?? "";

  if (SENSITIVE_HEADERS.has(name.toLowerCase())) return "[redacted]";

  if (new TextEncoder().encode(raw).length > MAX_HEADER_VALUE_BYTES) return "[long-redacted]";

  return raw;
}

function recordedBody(body: RecordedBody): Json {
  return { fields: body.fields, sample: body.sample, truncated: body.truncated };
}

/** Wraps an injected fetch with a bounded recorder of our own outbound requests. */
export function createCaptureFetch(
  upstream: typeof fetch,
  now: () => string = () => new Date().toISOString(),
): CaptureSink {
  const events: RequestEvent[] = [];

  const recorded: typeof fetch = async (input, init) => {
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();

    const target = targetOf(input);
    const supplied = init?.headers ?? (input instanceof Request ? input.headers : undefined);
    const headers = new Headers(supplied);
    const headerRecord: Record<string, string> = {};

    for (const name of headerNames(supplied)) headerRecord[name] = headerValue(headers, name);

    const body =
      init?.body !== undefined
        ? await describeBody(init.body)
        : input instanceof Request
          ? { fields: [], sample: "stream", truncated: false }
          : await describeBody(null);

    if (events.length < MAX_EVENTS)
      events.push({
        kind: "request",
        method,
        target,
        headers: headerRecord,
        body: recordedBody(body),
        at: now(),
      });

    try {
      const response = await upstream(input, init);

      if (events.length < MAX_EVENTS)
        events.push({
          kind: "response",
          method,
          target,
          status: response.status,
          headers: {},
          body: { kind: "not-captured" },
          at: now(),
        });

      return response;
    } catch (error) {
      if (events.length < MAX_EVENTS)
        events.push({
          kind: "error",
          method,
          target,
          headers: {},
          body: { kind: "not-captured" },
          at: now(),
        });
      throw error;
    }
  };

  return {
    fetch: recorded,
    snapshot: () => ({ schema: 1, events: events.map((event) => structuredClone(event)) }),
    clear: () => {
      events.length = 0;
    },
  };
}

/** Renders an evidence record with explicit classes and no free-form upstream claims. */
export function renderEvidence(
  question: string,
  observed: readonly string[],
  inferred: readonly string[],
  unknown: readonly string[],
): string {
  return [
    "# Compatibility evidence",
    "",
    `Question: ${question.slice(0, MAX_SAMPLE_BYTES)}`,
    "",
    "## Observed",
    ...(observed.length > 0 ? observed : ["- None"]),
    "",
    "## Inferred",
    ...(inferred.length > 0 ? inferred : ["- None"]),
    "",
    "## Unknown",
    ...(unknown.length > 0 ? unknown : ["- None"]),
  ].join("\n");
}

function isEvidencePayload(value: unknown): value is EvidencePayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;

  // SAFETY: JSON.parse yields a plain object; only the four named fields are read below.
  const record = Object.fromEntries(Object.entries(Object(value))) as UnknownPayload;

  const keys = ["observed", "inferred", "unknown"] as const;
  const question = record.question;

  return (
    (question === undefined || typeof question === "string") &&
    keys.every((key) => {
      const list = record[key];

      return isStringList(list);
    })
  );
}

function parseEvidence(text: string): EvidencePayload {
  const value: unknown = JSON.parse(text);

  if (!isEvidencePayload(value)) throw new Error("Invalid evidence input");

  const evidence: EvidencePayload = {
    observed: value.observed,
    inferred: value.inferred,
    unknown: value.unknown,
  };

  if (value.question !== undefined) evidence.question = value.question;

  return evidence;
}

async function main(args: string[]): Promise<void> {
  if (args.length !== 3 || args[0] !== "evidence")
    throw new Error("Usage: evidence <question> <json>");
  const evidence = parseEvidence(args[2]!);
  const question = args[1]!;

  const renderList = (items: readonly string[]): string[] =>
    items.length > 0 ? items.map((item) => `- ${item.slice(0, MAX_SAMPLE_BYTES)}`) : ["- None"];

  console.log(
    renderEvidence(
      question,
      renderList(evidence.observed),
      renderList(evidence.inferred),
      renderList(evidence.unknown),
    ),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(() => {
    console.error(
      "Compatibility command failed. Check arguments and input files; see docs/compatibility.md.",
    );
    process.exitCode = 1;
  });
}
