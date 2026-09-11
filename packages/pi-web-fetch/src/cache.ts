import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve, sep } from "node:path";
import { createHash } from "node:crypto";

interface ExpiringCacheEntry<V> {
  expiresAt: number;
  size: number;
  value: V;
}

/** A best-effort on-disk backing store for cache entries. */
export interface CachePersistence<K, V> {
  /** Directory that holds private cache files, created lazily with 0700 perms. */
  readonly directory: string;
  /** Serialize a value to bytes for on-disk storage. */
  serialize(value: V): Uint8Array;
  /** Deserialize bytes read from disk; throw on corrupt data so it is treated as a miss. */
  deserialize(bytes: Uint8Array): V;
  /** Map a logical cache key to a safe, collision-resistant on-disk filename. */
  keyToPath(key: K): string;
  /** Optionally reject structurally invalid payloads before they enter memory. */
  validate?: (value: V) => boolean;
}

/** Hashes a cache key into a safe, collision-resistant filename segment. */
export function stableKeyHash(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * Resolves a cache entry's on-disk path and refuses to escape the cache
 * directory, guarding against a `keyToPath` that returns `..` segments. The
 * `keyToPath` implementations in this repo return a hex SHA-256 digest, so this
 * never triggers in normal operation but keeps best-effort persistence safe.
 */
export function resolveCachePath(directory: string, keyPath: string): string {
  const base = resolve(directory);
  const full = resolve(base, keyPath);
  if (full !== base && !full.startsWith(base + sep)) {
    throw new Error(`Refusing to write cache entry outside ${base}: ${keyPath}`);
  }
  return full;
}

/**
 * Encodes an expiration timestamp as an 8-byte big-endian buffer.
 *
 * @param expiresAt - Expiration timestamp in milliseconds
 * @returns 8-byte buffer containing the encoded timestamp
 */
function encodeExpiresAt(expiresAt: number): Uint8Array {
  const out = new Uint8Array(8);
  let value = BigInt(Math.round(expiresAt));
  for (let index = 7; index >= 0; index -= 1) {
    out[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
}

/**
 * Decodes an 8-byte big-endian buffer to an expiration timestamp.
 *
 * @param bytes - 8-byte buffer containing the encoded timestamp
 * @returns Expiration timestamp in milliseconds
 */
function decodeExpiresAt(bytes: Uint8Array): number {
  let value = 0n;
  for (let index = 0; index < 8; index += 1) value = (value << 8n) | BigInt(bytes[index]);
  return Number(value);
}

/** An expiring least-recently-used cache bounded by entry count and aggregate bytes. */
export class ExpiringLruCache<K, V> {
  readonly #entries = new Map<K, ExpiringCacheEntry<V>>();
  #byteSize = 0;

  constructor(
    readonly maxEntries: number,
    readonly maxBytes: number,
    readonly sizeOf: (value: V) => number,
    readonly now: () => number = Date.now,
    readonly persistence?: CachePersistence<K, V>,
  ) {
    if (persistence) this.#maintainDisk();
  }

  /**
   * Gets the total byte size of all cached values.
   *
   * @returns Current aggregate byte size
   */
  get byteSize(): number {
    return this.#byteSize;
  }

  /**
   * Gets the number of cached entries.
   *
   * @returns Current entry count
   */
  get size(): number {
    return this.#entries.size;
  }

  /**
   * Retrieves a value from the cache, loading from disk if needed.
   *
   * @param key - Cache key
   * @returns Cached value or undefined if not found or expired
   */
  get(key: K): V | undefined {
    const entry = this.#entries.get(key);
    if (entry) {
      if (entry.expiresAt <= this.now()) {
        this.#delete(key);
        return undefined;
      }
      this.#entries.delete(key);
      this.#entries.set(key, entry);
      return entry.value;
    }
    if (this.persistence) {
      const loaded = this.#loadFromDisk(key);
      if (loaded !== undefined) return loaded.value;
    }
    return undefined;
  }

  /**
   * Stores a value in the cache with an expiration time.
   *
   * @param key - Cache key
   * @param value - Value to store
   * @param expiresAt - Expiration timestamp in milliseconds
   * @returns True if the value was stored, false if it was too large
   */
  set(key: K, value: V, expiresAt: number): boolean {
    this.#delete(key);
    const size = this.sizeOf(value);
    if (size > this.maxBytes) return false;

    this.#entries.set(key, { expiresAt, size, value });
    this.#byteSize += size;
    this.#evict();
    const stored = this.#entries.has(key);
    if (stored && this.persistence) this.#writeToDisk(key, value, expiresAt);
    return stored;
  }

  #loadFromDisk(key: K): ExpiringCacheEntry<V> | undefined {
    let bytes: Uint8Array;
    const path = resolveCachePath(this.persistence!.directory, this.persistence!.keyToPath(key));
    try {
      // Serialized metadata can exceed the value budget, but never allow an
      // unbounded cache file to be read into memory.
      const fileSize = statSync(path).size;
      if (fileSize < 8 || fileSize > this.maxBytes * 2 + 65_536)
        throw new Error("oversized cache file");
      bytes = readFileSync(path);
    } catch {
      this.#removeFromDisk(key);
      return undefined;
    }
    let entry: ExpiringCacheEntry<V>;
    try {
      const expiresAt = decodeExpiresAt(bytes);
      const value = this.persistence!.deserialize(bytes.subarray(8));
      if (this.persistence!.validate && !this.persistence!.validate(value)) {
        throw new Error("invalid cache entry");
      }
      const size = this.sizeOf(value);
      if (!Number.isFinite(size) || size < 0 || size > this.maxBytes)
        throw new Error("oversized cache entry");
      entry = { expiresAt, size, value };
    } catch {
      this.#removeFromDisk(key);
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.#removeFromDisk(key);
      return undefined;
    }
    this.#entries.set(key, entry);
    this.#byteSize += entry.size;
    this.#evict();
    return this.#entries.get(key);
  }

  #writeToDisk(key: K, value: V, expiresAt: number): void {
    try {
      const directory = this.persistence!.directory;
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      const payload = this.persistence!.serialize(value);
      if (payload.byteLength > this.maxBytes * 2 + 65_536)
        throw new Error("oversized cache payload");
      const path = resolveCachePath(directory, this.persistence!.keyToPath(key));
      const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      try {
        writeFileSync(temp, Buffer.concat([encodeExpiresAt(expiresAt), payload]), { mode: 0o600 });
        chmodSync(temp, 0o600);
        renameSync(temp, path);
      } finally {
        try {
          unlinkSync(temp);
        } catch {
          // The rename may already have removed the temporary path.
        }
      }
    } catch {
      // Best-effort persistence: a failed disk write never fails the caller.
    }
  }

  #removeFromDisk(key: K): void {
    try {
      unlinkSync(resolveCachePath(this.persistence!.directory, this.persistence!.keyToPath(key)));
    } catch {
      // Ignore missing or undeletable files; a cache miss is the correct outcome.
    }
  }

  #maintainDisk(): void {
    const persistence = this.persistence!;
    try {
      const files = readdirSync(persistence.directory);
      const candidates: Array<{ path: string; size: number; mtime: number }> = [];
      for (const file of files) {
        const path = resolveCachePath(persistence.directory, file);
        if (file.endsWith(".tmp")) {
          try {
            unlinkSync(path);
          } catch {
            // Best effort cleanup.
          }
          continue;
        }
        try {
          const stat = statSync(path);
          if (!stat.isFile() || stat.size < 8 || stat.size > this.maxBytes * 2 + 65_536) {
            unlinkSync(path);
            continue;
          }
          const descriptor = openSync(path, "r");
          const header = new Uint8Array(8);
          try {
            if (
              readSync(descriptor, header, 0, 8, 0) !== 8 ||
              decodeExpiresAt(header) <= this.now()
            ) {
              unlinkSync(path);
              continue;
            }
          } finally {
            closeSync(descriptor);
          }
          candidates.push({ path, size: stat.size, mtime: stat.mtimeMs });
        } catch {
          // Ignore races and inaccessible files in this best-effort sweep.
        }
      }
      candidates.sort((a, b) => a.mtime - b.mtime);
      let total = candidates.reduce((sum, candidate) => sum + candidate.size, 0);
      while (candidates.length > this.maxEntries || total > this.maxBytes * 2 + 65_536) {
        const oldest = candidates.shift();
        if (!oldest) break;
        total -= oldest.size;
        try {
          unlinkSync(oldest.path);
        } catch {
          // Best effort eviction.
        }
      }
    } catch {
      // Persistence is best effort and the directory may not exist yet.
    }
  }

  #evict(): void {
    while (this.#entries.size > this.maxEntries || this.#byteSize > this.maxBytes) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#delete(oldest);
    }
  }

  #delete(key: K): void {
    const entry = this.#entries.get(key);
    if (!entry) {
      if (this.persistence) this.#removeFromDisk(key);
      return;
    }
    this.#entries.delete(key);
    this.#byteSize -= entry.size;
    if (this.persistence) this.#removeFromDisk(key);
  }
}
