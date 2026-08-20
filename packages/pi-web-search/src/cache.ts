import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
}

/** Hashes a cache key into a safe, collision-resistant filename segment. */
export function stableKeyHash(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function encodeExpiresAt(expiresAt: number): Uint8Array {
  const out = new Uint8Array(8);
  let value = BigInt(Math.round(expiresAt));
  for (let index = 7; index >= 0; index -= 1) {
    out[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
}

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
  ) {}

  get byteSize(): number {
    return this.#byteSize;
  }

  get size(): number {
    return this.#entries.size;
  }

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
    const path = join(this.persistence!.directory, this.persistence!.keyToPath(key));
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(path);
    } catch {
      return undefined;
    }
    let entry: ExpiringCacheEntry<V>;
    try {
      if (bytes.byteLength < 8) throw new Error("cache file too small");
      const expiresAt = decodeExpiresAt(bytes);
      const value = this.persistence!.deserialize(bytes.subarray(8));
      const size = this.sizeOf(value);
      if (size > this.maxBytes) throw new Error("oversized cache entry");
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
      const path = join(directory, this.persistence!.keyToPath(key));
      const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      writeFileSync(temp, Buffer.concat([encodeExpiresAt(expiresAt), payload]), { mode: 0o600 });
      chmodSync(temp, 0o600);
      renameSync(temp, path);
    } catch {
      // Best-effort persistence: a failed disk write never fails the caller.
    }
  }

  #removeFromDisk(key: K): void {
    try {
      unlinkSync(join(this.persistence!.directory, this.persistence!.keyToPath(key)));
    } catch {
      // Ignore missing or undeletable files; a cache miss is the correct outcome.
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
