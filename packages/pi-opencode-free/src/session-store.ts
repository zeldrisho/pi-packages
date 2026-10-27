import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { SESSION_ID_PATTERN, sessionIdAgeMs } from "./fingerprint.ts";

/** Directory below the Pi agent directory that holds this provider's state. */
const STORE_DIRECTORY = "opencode-free";

/** State file name below {@link STORE_DIRECTORY}. */
const STORE_FILE_NAME = "session.json";

/** Current on-disk schema version. */
const STORE_VERSION = 1;

/**
 * How long a stored identity is reused before a fresh one is generated.
 *
 * The gateway accepts identifiers dated up to roughly ninety days back, so this
 * stays well inside that window while still rotating periodically.
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
  return join(directory, STORE_DIRECTORY, STORE_FILE_NAME);
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
        return parseSessionRecord(JSON.parse(readFileSync(path, "utf8")), now)?.id;
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

      const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;

      try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
        renameSync(temporary, path);
      } catch {
        // A lost identity only costs a new session slot on the next launch.
      }
    },
  };
}

/**
 * Chooses the identity to use for a run.
 *
 * Prefers an explicit override, then a reusable stored identity, and finally a
 * freshly created one. New identities are persisted so later runs reuse them.
 *
 * @param options - Clock reading, identity factory, store, and optional override
 * @returns Canonical identifier for this run
 */
export function resolveSessionId(options: {
  now: number;
  create: (now: number) => string;
  store?: SessionStore;
  override?: string;
}): string {
  const { now, create, store, override } = options;

  if (override && isReusableSessionId(override, now)) {
    store?.save(override, now);

    return override;
  }

  const stored = store?.load(now);

  if (stored) return stored;

  const id = create(now);

  store?.save(id, now);

  return id;
}
