import { mkdirSync } from "node:fs";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { ExpiringLruCache, stableKeyHash, type CachePersistence } from "../src/cache";
import type { CompleteDocument } from "../src/content";

const DAY_MS = 24 * 60 * 60 * 1_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function makePersistence(directory: string): CachePersistence<string, CompleteDocument> {
  return {
    directory,
    serialize: (document) => encoder.encode(JSON.stringify(document)),
    deserialize: (bytes) => JSON.parse(decoder.decode(bytes)) as CompleteDocument,
    keyToPath: (key) => stableKeyHash(key),
  };
}

function makeCache(
  directory: string,
  now: () => number = Date.now,
): ExpiringLruCache<string, CompleteDocument> {
  return new ExpiringLruCache<string, CompleteDocument>(
    3,
    1_000_000,
    (document) => encoder.encode(document.markdown).byteLength,
    now,
    makePersistence(directory),
  );
}

function document(url: string, markdown: string, shellSuspected = false): CompleteDocument {
  return { url, contentType: "text/plain", markdown, shellSuspected, extractor: "raw" };
}

describe("web_fetch disk cache", () => {
  let directory = "";
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-web-fetch-cache-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("survives a simulated restart within the TTL", async () => {
    let now = 1_000;
    const first = makeCache(directory, () => now);
    first.set("https://example.com/a", document("https://example.com/a", "alpha"), now + DAY_MS);

    now = 2_000;
    const second = makeCache(directory, () => now);
    const loaded = second.get("https://example.com/a");

    expect(loaded).toBeDefined();
    expect(loaded?.markdown).toBe("alpha");
    expect(loaded?.url).toBe("https://example.com/a");
  });

  it("treats an expired on-disk entry as a miss and removes its file", async () => {
    let now = 1_000;
    const first = makeCache(directory, () => now);
    first.set("https://example.com/exp", document("https://example.com/exp", "x"), now + 1_000);

    now = 5_000;
    const second = makeCache(directory, () => now);
    expect(second.get("https://example.com/exp")).toBeUndefined();

    const files = await readdir(directory);
    expect(files).not.toContain(stableKeyHash("https://example.com/exp"));
  });

  it("deletes backing files when entries are evicted by the count limit", async () => {
    let now = 0;
    const cache = makeCache(directory, () => now);
    for (const key of ["a", "b", "c", "d"]) {
      cache.set(key, document(key, key.repeat(10)), now + DAY_MS);
    }

    expect(cache.size).toBe(3);
    const files = await readdir(directory);
    expect(files).not.toContain(stableKeyHash("a"));
    expect(files).toContain(stableKeyHash("d"));
  });

  it("treats corrupt files as a miss without throwing", async () => {
    let now = 0;
    const first = makeCache(directory, () => now);
    first.set("https://example.com/c", document("https://example.com/c", "clean"), now + DAY_MS);

    const path = join(directory, stableKeyHash("https://example.com/c"));
    await writeFile(path, "this is not valid cache data", "utf8");

    const second = makeCache(directory, () => now);
    expect(() => second.get("https://example.com/c")).not.toThrow();
    expect(second.get("https://example.com/c")).toBeUndefined();
  });

  it("treats too-short on-disk files as a miss", async () => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, stableKeyHash("https://example.com/short"));
    await writeFile(path, Buffer.from([1, 2, 3, 4]), "utf8");

    const cache = makeCache(directory, () => 0);
    expect(cache.get("https://example.com/short")).toBeUndefined();
  });

  it("treats oversized on-disk entries as a miss", async () => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, stableKeyHash("https://example.com/big"));
    const header = new Uint8Array(8);
    const payload = encoder.encode(
      JSON.stringify(document("https://example.com/big", "z".repeat(2_000_000))),
    );
    await writeFile(path, Buffer.concat([header, payload]), "utf8");

    const cache = makeCache(directory, () => 0);
    expect(cache.get("https://example.com/big")).toBeUndefined();
  });

  it("rejects individually oversized entries and stores nothing", () => {
    const cache = makeCache(directory);
    expect(cache.set("big", document("big", "y".repeat(2_000_000)), Date.now() + DAY_MS)).toBe(
      false,
    );
    expect(cache.get("big")).toBeUndefined();
  });

  it("writes a private 0600 backing file in a 0700 directory on set", async () => {
    const cache = makeCache(directory);
    cache.set(
      "https://example.com/w",
      document("https://example.com/w", "written"),
      Date.now() + DAY_MS,
    );

    const filePath = join(directory, stableKeyHash("https://example.com/w"));
    const fileStat = await stat(filePath);
    expect(fileStat.isFile()).toBe(true);
    expect(fileStat.mode & 0o777).toBe(0o600);

    const dirStat = await stat(directory);
    expect(dirStat.mode & 0o777).toBe(0o700);
  });

  it("hashes keys into collision-resistant, filesystem-safe names", () => {
    const key = "https://example.com/a/b?c=1&d=2";
    expect(stableKeyHash(key)).not.toContain("/");
    expect(stableKeyHash(key)).not.toContain(":");
    expect(stableKeyHash(key)).toBe(stableKeyHash(key));
    expect(stableKeyHash("a")).not.toBe(stableKeyHash("b"));
  });
});
