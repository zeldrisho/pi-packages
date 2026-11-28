import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;

const MAX_SNAPSHOT_BYTES = 16 * 1024;

const CHUNK_BYTES = 1024 * 1024;

const MARKERS = {
  antigravity: ["streamGenerateContent", "fetchAvailableModels", "requestType", "thoughtSignature"],
  opencode: ["x-opencode-client", "x-opencode-session", "x-session-affinity", "Working directory:"],
} as const;

type Provider = keyof typeof MARKERS;

type Format = "elf" | "pe" | "mach-o" | "other";

type ProviderMarkers = (typeof MARKERS)[Provider][number];

interface SnapshotPayload extends Record<string, unknown> {
  schema: number;
  provider: unknown;
  sha256: unknown;
  bytes: unknown;
  format: unknown;
  markers: unknown;
}

interface Snapshot {
  schema: 1;
  provider: Provider;
  sha256: string;
  bytes: number;
  format: Format;
  markers: Readonly<Record<ProviderMarkers, boolean>>;
}

function providerFor(value: string): Provider {
  if (value === "antigravity" || value === "opencode") return value;
  throw new Error("Provider must be antigravity or opencode");
}

function formatOf(header: Buffer): Format {
  if (header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return "elf";

  if (header.subarray(0, 2).equals(Buffer.from("MZ"))) return "pe";

  if (
    ["cffaedfe", "feedfacf", "cafebabe", "bebafeca"].includes(header.subarray(0, 4).toString("hex"))
  ) {
    return "mach-o";
  }

  return "other";
}

/** Inspect only an explicitly selected artifact; never execute it or emit its contents. */
export async function capture(providerName: string, path: string): Promise<Snapshot> {
  const provider = providerFor(providerName);
  const file = await open(path, "r");

  try {
    const stat = await file.stat();

    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_ARTIFACT_BYTES) {
      throw new Error("Artifact must be a nonempty regular file within the size limit");
    }
    const hash = createHash("sha256");
    // SAFETY: Every provider marker is initialized in the loop below.
    const markers = {} as Record<ProviderMarkers, boolean>;

    for (const marker of MARKERS[provider]) markers[marker] = false;
    const carryLength = Math.max(...MARKERS[provider].map((marker) => marker.length)) - 1;
    const buffer = Buffer.alloc(CHUNK_BYTES);
    let carry = "";
    let position = 0;
    let format: Format = "other";

    while (position < stat.size) {
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, stat.size - position),
        position,
      );

      if (bytesRead === 0) throw new Error("Artifact changed during capture");
      const chunk = buffer.subarray(0, bytesRead);

      if (position === 0) format = formatOf(chunk);
      position += bytesRead;
      hash.update(chunk);
      const text = carry + chunk.toString("latin1");

      for (const marker of MARKERS[provider]) if (text.includes(marker)) markers[marker] = true;
      carry = text.slice(-carryLength);
    }

    const after = await file.stat();

    if (
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    ) {
      throw new Error("Artifact changed during capture");
    }

    return { schema: 1, provider, sha256: hash.digest("hex"), bytes: position, format, markers };
  } finally {
    await file.close();
  }
}

function isRecord(value: unknown): value is SnapshotPayload {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/** Validate snapshots before rendering: no arbitrary input is echoed. */
export function parseSnapshot(input: string): Snapshot {
  const value: unknown = JSON.parse(input);

  if (!isRecord(value)) throw new Error("Invalid snapshot");
  const obj = value;

  if (
    obj.schema !== 1 ||
    (obj.provider !== "antigravity" && obj.provider !== "opencode") ||
    !isString(obj.sha256) ||
    !/^[a-f0-9]{64}$/.test(obj.sha256) ||
    !isNumber(obj.bytes) ||
    !Number.isSafeInteger(obj.bytes) ||
    obj.bytes < 1 ||
    obj.bytes > MAX_ARTIFACT_BYTES ||
    (obj.format !== "elf" &&
      obj.format !== "pe" &&
      obj.format !== "mach-o" &&
      obj.format !== "other") ||
    !isRecord(obj.markers)
  ) {
    throw new Error("Invalid snapshot");
  }
  const provider = providerFor(obj.provider);
  // SAFETY: Every provider marker is validated below before this object is returned.
  const markers = {} as Record<ProviderMarkers, boolean>;
  const raw = obj.markers;

  if (!isRecord(raw) || Object.keys(raw).length !== MARKERS[provider].length) {
    throw new Error("Invalid markers");
  }

  for (const marker of MARKERS[provider]) {
    const found = raw[marker];

    if (!isBoolean(found)) throw new Error("Invalid markers");
    markers[marker] = found;
  }

  return { schema: 1, provider, sha256: obj.sha256, bytes: obj.bytes, format: obj.format, markers };
}

export function compare(before: Snapshot, after: Snapshot): string[] {
  if (before.provider !== after.provider) throw new Error("Snapshots have different providers");

  const lines = [
    `provider: ${before.provider}`,
    `sha256 changed: ${before.sha256 !== after.sha256}`,
    `bytes: ${before.bytes} -> ${after.bytes}`,
    `format: ${before.format} -> ${after.format}`,
  ];

  for (const marker of MARKERS[before.provider]) {
    if (before.markers[marker] !== after.markers[marker]) {
      lines.push(`${marker}: ${before.markers[marker]} -> ${after.markers[marker]}`);
    }
  }

  return lines;
}

async function readSnapshot(path: string): Promise<Snapshot> {
  const file = await open(path, "r");

  try {
    const stat = await file.stat();

    if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES) throw new Error("Invalid snapshot size");
    const buffer = Buffer.alloc(MAX_SNAPSHOT_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);

    if (bytesRead > MAX_SNAPSHOT_BYTES) throw new Error("Invalid snapshot size");

    return parseSnapshot(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await file.close();
  }
}

async function main(args: string[]): Promise<void> {
  if (args.length === 3 && args[0] === "capture") {
    console.log(JSON.stringify(await capture(args[1], args[2]), null, 2));
  } else if (args.length === 3 && args[0] === "compare") {
    console.log(compare(await readSnapshot(args[1]), await readSnapshot(args[2])).join("\n"));
  } else {
    throw new Error(
      "Usage: compatibility capture <antigravity|opencode> <artifact> | compare <before.json> <after.json>",
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch {
    console.error(
      "Compatibility command failed. Check arguments and input files; see docs/compatibility.md.",
    );
    process.exitCode = 1;
  }
}
