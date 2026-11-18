import { constants } from "node:fs";
import { access, open, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, delimiter, dirname, isAbsolute, join, relative } from "node:path";

/** OAuth application identity read from an installed CLI, never an account token. */
export interface OAuthClient {
  id: string;
  secret: string;
}

/** Fingerprints let discovery reject unknown clients and ambiguous binaries. */
export interface ClientFingerprints {
  id: string;
  secrets: readonly string[];
}

// Consumer-client fingerprints, independently reported by agy-auth. These do
// not pin a CLI version; a rotated or unrecognized client fails closed.
const CONSUMER_CLIENT: ClientFingerprints = {
  id: "bf00c418024ba6bf606ccdc37120976e41bc429dd1d46ecf16a729aa532626ea",
  secrets: [
    "1d2f041093fd95aa8995a038c711d50a7960da09a505381c09a745d6ad0ecc60",
    "23d89fc5fbce73ed5b9e0cf0ca786bd0eb1bcdff8f65d03dc022d299ad2234b6",
  ],
};

const MAX_BINARY_BYTES = 512 * 1024 * 1024;

const CHUNK_BYTES = 1024 * 1024;

const CARRY_BYTES = 256;

const MAX_WRAPPER_BYTES = 16 * 1024;

/** Bound work on malformed or deliberately adversarial executables. */
const MAX_CANDIDATES = 2_048;

let cachedClient: { key: string; client: OAuthClient } | undefined;

/** Hashes a candidate without logging it or persisting it. */
function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Returns true for executable file formats supported by CLI installations. */
function isBinary(header: Buffer): boolean {
  return (
    header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
    header.subarray(0, 2).equals(Buffer.from("MZ")) ||
    ["cffaedfe", "feedfacf", "cafebabe", "bebafeca"].includes(header.subarray(0, 4).toString("hex"))
  );
}

/** Reads recognized candidates from one bounded binary without retaining its contents. */
export async function scanClientBinary(
  path: string,
  expected: ClientFingerprints = CONSUMER_CLIENT,
  signal?: AbortSignal,
): Promise<OAuthClient | undefined> {
  signal?.throwIfAborted();
  const file = await open(path, "r");
  const ids = new Set<string>();
  const secrets = new Set<string>();

  try {
    const stats = await file.stat();

    if (!stats.isFile() || stats.size < 4 || stats.size > MAX_BINARY_BYTES) return undefined;
    const header = Buffer.alloc(4);

    if ((await file.read(header, 0, 4, 0)).bytesRead !== 4 || !isBinary(header)) return undefined;
    const buffer = Buffer.alloc(CHUNK_BYTES);
    let carry = "";
    let position = 0;
    let candidates = 0;

    while (position < stats.size) {
      signal?.throwIfAborted();

      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, stats.size - position),
        position,
      );

      if (bytesRead === 0) return undefined;
      position += bytesRead;
      const text = carry + buffer.subarray(0, bytesRead).toString("latin1");

      for (const match of text.matchAll(/[0-9a-z-]{13,128}\.apps\.googleusercontent\.com/g)) {
        if (++candidates > MAX_CANDIDATES) return undefined;
        const candidate = match[0];

        for (let offset = 0; offset <= candidate.length - 40; offset += 1) {
          const id = candidate.slice(offset);

          if (fingerprint(id) === expected.id) ids.add(id);
        }
      }

      for (const match of text.matchAll(/GOCSPX-[A-Za-z0-9_-]{13,121}/g)) {
        if (++candidates > MAX_CANDIDATES) return undefined;
        const candidate = match[0];

        for (let length = 20; length <= candidate.length; length += 1) {
          const secret = candidate.slice(0, length);

          if (expected.secrets.includes(fingerprint(secret))) secrets.add(secret);
        }
      }

      carry = text.slice(-CARRY_BYTES);
    }

    if (ids.size !== 1 || secrets.size !== 1) return undefined;
    const id = ids.values().next().value;
    const secret = secrets.values().next().value;

    return id === undefined || secret === undefined ? undefined : { id, secret };
  } finally {
    await file.close();
  }
}

/** Resolves a CLI binary or a narrowly recognized Homebrew command wrapper. */
async function binaryPath(path: string): Promise<string | undefined> {
  const resolved = await realpath(path);
  const file = await open(resolved, "r");

  try {
    const stats = await file.stat();

    if (!stats.isFile() || stats.size < 4 || stats.size > MAX_BINARY_BYTES) return undefined;
    const header = Buffer.alloc(4);

    if ((await file.read(header, 0, 4, 0)).bytesRead !== 4) return undefined;

    if (isBinary(header)) return resolved;

    if (
      stats.size > MAX_WRAPPER_BYTES ||
      basename(dirname(resolved)) !== ".homebrew-command-wrappers"
    )
      return undefined;
    const contents = await file.readFile({ encoding: "utf8" });

    const target = contents.match(
      /^AGY_CLI_DISABLE_AUTO_UPDATE="true" exec "([^"\n]+)"\s+"\$@"\s*$/m,
    )?.[1];

    if (target === undefined || !isAbsolute(target) || basename(target) !== "antigravity")
      return undefined;
    const parent = dirname(dirname(resolved));
    const realTarget = await realpath(target);

    if (relative(parent, realTarget) !== "antigravity") return undefined;

    return realTarget;
  } finally {
    await file.close();
  }
}

/** Finds an installed CLI on PATH without executing it or reading its account storage. */
export async function discoverAgyClient(
  signal?: AbortSignal,
  expected: ClientFingerprints = CONSUMER_CLIENT,
): Promise<OAuthClient | undefined> {
  const paths = (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, "agy"));

  for (const path of paths) {
    signal?.throwIfAborted();

    try {
      await access(path, constants.X_OK);
      const binary = await binaryPath(path);

      if (binary === undefined) continue;
      const stats = await stat(binary);
      const key = `${binary}:${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
      signal?.throwIfAborted();

      if (expected === CONSUMER_CLIENT && cachedClient?.key === key) return cachedClient.client;
      const client = await scanClientBinary(binary, expected, signal);

      if (client !== undefined) {
        if (expected === CONSUMER_CLIENT) cachedClient = { key, client };

        return client;
      }
    } catch {
      signal?.throwIfAborted();
      // Do not surface untrusted paths or filesystem error messages.
    }
  }

  return undefined;
}
