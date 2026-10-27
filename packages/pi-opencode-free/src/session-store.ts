import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { SESSION_ID_PATTERN, sessionIdAgeMs } from "./client-headers.ts";

/** State file name below the Pi agent directory. */
const STORE_FILE_NAME = "opencode-free.json";

/** Current on-disk schema version. */
const STORE_VERSION = 1;

/** Upper bound for the small persisted JSON record. */
const MAX_RECORD_BYTES = 4_096;

/**
 * How long a stored identity is reused before a fresh one is generated.
 *
 * This is a local retention policy, not a guarantee of upstream entitlement.
 */
export const SESSION_REUSE_MS = 30 * 24 * 60 * 60 * 1000;

/** Identifiers dated this far ahead are tolerated for modest clock drift. */
export const SESSION_FUTURE_TOLERANCE_MS = 2 * 24 * 60 * 60 * 1000;

/** Persisted session identity. */
export interface SessionRecord {
  id: string;
  createdAt: number;
}

/** Loads and saves the provider's session identity. */
export interface SessionStore {
  load(now: number): string | undefined;
  save(id: string, now: number): void;
}

/**
 * Resolves the Pi agent directory the same way Pi and sibling packages do.
 *
 * @returns Absolute agent directory path
 */
export function agentDirectory(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/**
 * Returns the absolute path of the session identity file.
 *
 * @param directory - Agent directory to use instead of the default
 * @returns Absolute path to the JSON state file
 */
export function sessionStorePath(directory = agentDirectory()): string {
  return join(directory, STORE_FILE_NAME);
}

/**
 * Checks whether an identifier may be reused at a reference time.
 *
 * Rejects malformed identifiers, identifiers dated beyond the acceptance
 * window, and identifiers older than {@link SESSION_REUSE_MS}.
 *
 * @param id - Candidate identifier
 * @param now - Reference time in epoch milliseconds
 * @returns Whether the identifier is safe to reuse
 */
export function isReusableSessionId(id: string, now: number): boolean {
  if (!Number.isFinite(now)) return false;

  if (!SESSION_ID_PATTERN.test(id)) return false;

  const age = sessionIdAgeMs(id, now);

  return age !== undefined && age >= -SESSION_FUTURE_TOLERANCE_MS && age < SESSION_REUSE_MS;
}

/**
 * Type guard that accepts a plain JSON object from disk.
 *
 * @param value - Untrusted parsed JSON value
 * @returns Whether the value is a non-null, non-array object
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- narrows untrusted JSON at the storage boundary
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses a persisted record, requiring the stored id to remain reusable.
 *
 * @param value - Parsed JSON value
 * @param now - Reference time in epoch milliseconds
 * @returns The reusable record, or undefined when absent, malformed, or stale
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- accepts untrusted file contents before validation
export function parseSessionRecord(value: unknown, now: number): SessionRecord | undefined {
  if (!isJsonObject(value)) return undefined;

  const { version, id, createdAt } = value;

  if (version !== STORE_VERSION) return undefined;

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validates untrusted persisted JSON at the storage boundary
  if (typeof id !== "string" || !isReusableSessionId(id, now)) return undefined;

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validates untrusted persisted JSON at the storage boundary
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return undefined;

  const age = now - createdAt;

  if (age < -SESSION_FUTURE_TOLERANCE_MS || age >= SESSION_REUSE_MS) return undefined;

  return { id, createdAt };
}

/**
 * Creates a store backed by a JSON file.
 *
 * Reads and writes are best-effort: a missing, unreadable, or unwritable file
 * never prevents inference, it only costs a fresh identity.
 *
 * @param path - Absolute path of the JSON state file
 * @returns Store backed by that file
 */
export function createSessionStore(path = sessionStorePath()): SessionStore {
  return {
    load(now) {
      try {
        const descriptor = openSync(path, "r");

        try {
          const bytes = Buffer.alloc(MAX_RECORD_BYTES + 1);
          const length = readSync(descriptor, bytes, 0, bytes.length, 0);

          if (length > MAX_RECORD_BYTES) return undefined;

          return parseSessionRecord(JSON.parse(bytes.toString("utf8", 0, length)), now)?.id;
        } finally {
          closeSync(descriptor);
        }
      } catch {
        return undefined;
      }
    },
    save(id, now) {
      const record: SessionRecord & { version: number } = {
        version: STORE_VERSION,
        id,
        createdAt: now,
      };

      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;

      try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
        renameSync(temporary, path);
      } catch {
        // Persistence must not prevent inference.
      } finally {
        try {
          unlinkSync(temporary);
        } catch {
          // The rename normally consumed the temporary file already.
        }
      }
    },
  };
}

/**
 * Chooses the identity to use for a run.
 *
 * Reuses a stored identity when it is still reusable and otherwise creates and
 * persists a fresh one.
 *
 * @param options - Clock reading, identity factory, and store
 * @returns Canonical identifier for this run
 */
export function resolveSessionId(options: {
  now: number;
  create: (now: number) => string;
  store?: SessionStore;
}): string {
  const { now, create, store } = options;

  const stored = store?.load(now);

  if (stored && isReusableSessionId(stored, now)) return stored;

  const id = create(now);

  store?.save(id, now);

  return id;
}
