import { createHash, randomBytes } from "node:crypto";
import type { ProviderHeaders } from "@earendil-works/pi-ai";

/** Marks requests assembled for the extension's own provider. */
export const PROVIDER_MARKER_HEADER = "x-pi-opencode-free";

/** Canonical OpenCode session headers mirrored by the v2 CLI. */
export const SESSION_HEADER_NAMES = [
  "x-opencode-session",
  "x-opencode-session-id",
  "x-session-affinity",
  "x-session-id",
] as const;

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

const SESSION_PREFIX = "ses_";

const SESSION_MASK_48 = 0xffffffffffffn;

const SESSION_TS_MASK_36 = 0xfffffffffn;

const SESSION_COUNTER = 1n;

const SESSION_HEX_LENGTH = 12;

const SESSION_SUFFIX_LENGTH = 14;

const SESSION_SEED_LENGTH = 20;

/** Milliseconds representable by the identifier's 36-bit timestamp field. */
const SESSION_TS_MODULUS = 2 ** 36;

/** Half the timestamp range; larger differences are read as the nearer side. */
const SESSION_TS_HALF = SESSION_TS_MODULUS / 2;

/** Canonical identifier shape: hex timestamp half plus a fourteen-character suffix. */
export const SESSION_ID_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/u;

/** Largest multiple of the base62 alphabet size that fits in a byte. */
const BASE62_UNBIASED_LIMIT = BASE62.length * 4;

/**
 * Renders the base62 suffix without modulo bias.
 *
 * Bytes at or above the largest full multiple of the alphabet are rejected so
 * every digit keeps the same probability. Deterministic hash output supplies
 * more bytes if the seed runs out after rejections.
 *
 * @param seed - At least twenty bytes; the suffix starts at byte six
 * @returns Exactly fourteen base62 characters
 */
function createSessionSuffix(seed: Uint8Array): string {
  const digits: string[] = [];
  let bytes: Uint8Array = seed.subarray(6, SESSION_SEED_LENGTH);
  let counter = 0;

  while (digits.length < SESSION_SUFFIX_LENGTH) {
    for (const byte of bytes) {
      if (digits.length === SESSION_SUFFIX_LENGTH) break;

      if (byte >= BASE62_UNBIASED_LIMIT) continue;

      let index = byte;

      while (index >= BASE62.length) index -= BASE62.length;
      digits.push(BASE62[index] ?? "0");
    }

    if (digits.length === SESSION_SUFFIX_LENGTH) break;

    counter += 1;
    bytes = createHash("sha256").update(seed).update(String(counter)).digest();
  }

  return digits.join("");
}

/**
 * Builds the OpenCode v2 CLI user agent for a client version.
 *
 * @param cliVersion - Version placed between the `latest` channel and `cli` client
 * @returns The user agent expected by the free-tier gate
 */
export function buildUserAgent(cliVersion: string): string {
  return `opencode/latest/${cliVersion}/cli`;
}

/**
 * Tool declaration required by the free-tier gate. The schema matches the
 * OpenCode v2 CLI's own `read` tool declaration.
 */
export const READ_TOOL = {
  type: "function",
  function: {
    name: "read",
    description:
      "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File or directory to read" },
        offset: {
          type: "integer",
          minimum: 0,
          description: "The line or directory entry to start reading from (1-based)",
        },
        limit: {
          type: "integer",
          minimum: 0,
          description:
            "The maximum number of lines or directory entries to read (defaults to and capped at 2000)",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    strict: false,
  },
} as const;

/**
 * Creates the random seed backing a canonical session id.
 *
 * @returns Twenty cryptographically random bytes for a canonical session identifier
 * @throws If cryptographic random byte generation fails
 */
export function createSessionSeed(): Uint8Array {
  return randomBytes(SESSION_SEED_LENGTH);
}

/**
 * Renders OpenCode CLI's canonical session identifier shape.
 *
 * The 48-bit hex half reproduces `Identifier.descending()` with the counter
 * pinned to one, so the low twelve bits always read `ffe`. Its high 36 bits
 * carry the creation time, which the inference gateway checks for recency
 * before honouring the free tier. The fourteen-character suffix is derived
 * from the seed.
 *
 * @param seed - At least twenty bytes; defaults to fresh cryptographic randomness
 * @param now - Creation time in epoch milliseconds, defaulting to the wall clock
 * @returns A canonical `ses_` identifier; upstream acceptance is not guaranteed
 * @throws If the seed contains fewer than twenty bytes or default seed generation fails
 */
export function createCanonicalSessionId(
  seed: Uint8Array = createSessionSeed(),
  now: number = Date.now(),
): string {
  if (seed.length < SESSION_SEED_LENGTH) {
    throw new Error(`Session seed must contain at least ${SESSION_SEED_LENGTH} bytes`);
  }

  const timestampBits = BigInt(now) & SESSION_TS_MASK_36;

  const encoded = ~((timestampBits << 12n) | SESSION_COUNTER) & SESSION_MASK_48;

  return `${SESSION_PREFIX}${encoded.toString(16).padStart(SESSION_HEX_LENGTH, "0")}${createSessionSuffix(seed)}`;
}

/**
 * Reads the creation time a canonical identifier carries.
 *
 * The timestamp wraps every {@link SESSION_TS_MODULUS} milliseconds, so callers
 * must compare it with a nearby reference time rather than treating it as an
 * absolute date.
 *
 * @param id - Candidate identifier
 * @returns Creation time modulo the timestamp range, or undefined for a malformed id
 */
export function sessionIdCreatedAt(id: string): number | undefined {
  if (!SESSION_ID_PATTERN.test(id)) return undefined;

  const match = /^ses_([0-9a-f]{12})/u.exec(id);

  if (!match?.[1]) return undefined;

  const encoded = BigInt(`0x${match[1]}`);

  return Number((~encoded & SESSION_MASK_48) >> 12n);
}

/**
 * Measures how long ago a canonical identifier was created.
 *
 * The result is signed and wrapped into half the timestamp range, so identifiers
 * created in the future read as small negative ages and stale identifiers read
 * as large positive ages.
 *
 * @param id - Candidate identifier
 * @param now - Reference time in epoch milliseconds
 * @returns Age in milliseconds, or undefined for a malformed id
 */
export function sessionIdAgeMs(id: string, now: number): number | undefined {
  const createdAt = sessionIdCreatedAt(id);

  if (createdAt === undefined) return undefined;

  const age = (((now - createdAt) % SESSION_TS_MODULUS) + SESSION_TS_MODULUS) % SESSION_TS_MODULUS;

  return age > SESSION_TS_HALF ? age - SESSION_TS_MODULUS : age;
}

/**
 * Builds the static headers sent with every provider request.
 *
 * @param sessionId - Canonical session identifier for the active Pi session
 * @param cliVersion - Client version carried by the user agent
 * @returns Provider headers that declare the client identity
 */
export function buildClientHeaders(sessionId: string, cliVersion: string) {
  return {
    "User-Agent": buildUserAgent(cliVersion),
    "x-opencode-client": "cli",
    "x-opencode-project": "global",
    [PROVIDER_MARKER_HEADER]: "1",
    "x-opencode-session": sessionId,
    "x-opencode-session-id": sessionId,
    "x-session-affinity": sessionId,
    "x-session-id": sessionId,
  } satisfies Record<string, string>;
}

/**
 * Updates the active session id on requests assembled for this provider.
 *
 * The marker header keeps the mutation from leaking into built-in providers
 * that share the OpenCode endpoint but do not use the free-tier client headers.
 * Matching header names are replaced case-insensitively, and the legacy
 * `x-opencode-request` header is removed. Unmarked requests are left unchanged.
 *
 * @param headers - Mutable request headers supplied by Pi
 * @param sessionId - Canonical session identifier for the active Pi session
 * @param cliVersion - Client version carried by the user agent
 * @returns Whether the request belonged to this extension
 */
export function applyClientHeaders(
  headers: ProviderHeaders,
  sessionId: string,
  cliVersion: string,
): boolean {
  if (!hasProviderMarker(headers)) return false;

  setHeader(headers, "User-Agent", buildUserAgent(cliVersion));
  setHeader(headers, "x-opencode-client", "cli");
  setHeader(headers, "x-opencode-project", "global");

  for (const name of SESSION_HEADER_NAMES) {
    setHeader(headers, name, sessionId);
  }

  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === "x-opencode-request") delete headers[name];
  }

  return true;
}

/** Checks for a case-insensitive marker header whose value is exactly `"1"`. */
function hasProviderMarker(headers: ProviderHeaders): boolean {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === PROVIDER_MARKER_HEADER && value === "1") return true;
  }

  return false;
}

/** Replaces all case variants of a header in place with the supplied spelling and value. */
function setHeader(headers: ProviderHeaders, name: string, value: string): void {
  for (const existing of Object.keys(headers)) {
    if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing];
  }

  headers[name] = value;
}
