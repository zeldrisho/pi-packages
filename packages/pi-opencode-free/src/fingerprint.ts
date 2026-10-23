import { createHash, randomBytes } from "node:crypto";
import type { ProviderHeaders } from "@earendil-works/pi-ai";

/**
 * Synthetic major-2 client version used when no override is configured.
 *
 * The free-tier gate checks the major version, not a specific release, so a
 * high compatibility version avoids pinning the extension to one OpenCode
 * release.
 */
export const DEFAULT_CLI_VERSION = "2.999.0";

/** Marks requests assembled for the extension's own provider. */
export const FINGERPRINT_MARKER_HEADER = "x-pi-opencode-free";

const CLI_VERSION_PATTERN = /^\d+\.\d+(?:\.\d+)?$/u;

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
 * Resolves the client version carried by the request fingerprint.
 *
 * @param environment - Environment variables visible to the extension
 * @returns `OPENCODE_FREE_CLI_VERSION` when valid, else the compatibility version
 */
export function resolveCliVersion(environment: Record<string, string | undefined>): string {
  const configured = environment.OPENCODE_FREE_CLI_VERSION?.trim();

  if (configured && CLI_VERSION_PATTERN.test(configured)) return configured;

  return DEFAULT_CLI_VERSION;
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
 * @returns Twenty random bytes: five for the encoded time half and fifteen for the suffix
 */
export function createSessionSeed(): Uint8Array {
  return randomBytes(SESSION_SEED_LENGTH);
}

/**
 * Renders OpenCode CLI's canonical session identifier shape.
 *
 * The 48-bit hex half reproduces `Identifier.descending()` with the counter
 * pinned to one, so the low twelve bits always read `ffe`. The high 36 bits are
 * derived from the seed, matching the reference implementation, while the
 * fourteen-character suffix uses the remaining seed bytes.
 *
 * @param seed - At least twenty bytes; defaults to fresh cryptographic randomness
 * @returns A `ses_` identifier accepted by the free-tier gate
 */
export function createCanonicalSessionId(seed: Uint8Array = createSessionSeed()): string {
  if (seed.length < SESSION_SEED_LENGTH) {
    throw new Error(`Session seed must contain at least ${SESSION_SEED_LENGTH} bytes`);
  }

  const timestampBits =
    ((BigInt(seed[0] ?? 0) << 28n) |
      (BigInt(seed[1] ?? 0) << 20n) |
      (BigInt(seed[2] ?? 0) << 12n) |
      (BigInt(seed[3] ?? 0) << 4n) |
      (BigInt(seed[4] ?? 0) >> 4n)) &
    SESSION_TS_MASK_36;

  const encoded = ~((timestampBits << 12n) | SESSION_COUNTER) & SESSION_MASK_48;

  return `${SESSION_PREFIX}${encoded.toString(16).padStart(SESSION_HEX_LENGTH, "0")}${createSessionSuffix(seed)}`;
}

/**
 * Builds the static headers sent with every provider request.
 *
 * @param sessionId - Canonical session identifier for the active Pi session
 * @param cliVersion - Client version carried by the user agent
 * @returns Provider headers carrying the v2 CLI fingerprint
 */
export function buildFingerprintHeaders(sessionId: string, cliVersion: string) {
  return {
    "User-Agent": buildUserAgent(cliVersion),
    "x-opencode-client": "cli",
    "x-opencode-project": "global",
    [FINGERPRINT_MARKER_HEADER]: "1",
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
 * that share the OpenCode endpoint but do not use the free-tier fingerprint.
 *
 * @param headers - Mutable request headers supplied by Pi
 * @param sessionId - Canonical session identifier for the active Pi session
 * @param cliVersion - Client version carried by the user agent
 * @returns Whether the request belonged to this extension
 */
export function applyFingerprintHeaders(
  headers: ProviderHeaders,
  sessionId: string,
  cliVersion: string,
): boolean {
  if (!hasFingerprintMarker(headers)) return false;

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

function hasFingerprintMarker(headers: ProviderHeaders): boolean {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === FINGERPRINT_MARKER_HEADER && value === "1") return true;
  }

  return false;
}

function setHeader(headers: ProviderHeaders, name: string, value: string): void {
  for (const existing of Object.keys(headers)) {
    if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing];
  }

  headers[name] = value;
}
