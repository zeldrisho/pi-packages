import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { ExpiringLruCache, stableKeyHash, type CachePersistence } from "../src/cache";
import type { SearchResult } from "../src/brave";

const DAY_MS = 24 * 60 * 60 * 1_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function makePersistence(directory: string): CachePersistence<string, SearchResult[]> {
  return {
    directory,
    serialize: (results) => encoder.encode(JSON.stringify(results)),
    deserialize: (bytes) => JSON.parse(decoder.decode(bytes)) as SearchResult[],
    keyToPath: (key) => stableKeyHash(key),
  };
}

function makeCache(
  directory: string,
  now: () => number = Date.now,
): ExpiringLruCache<string, SearchResult[]> {
  return new ExpiringLruCache<string, SearchResult[]>(
    3,
    1_000_000,
    (results) => encoder.encode(JSON.stringify(results)).byteLength,
    now,
    makePersistence(directory),
  );
}

function results(...urls: string[]): SearchResult[] {
  return urls.map((url) => ({ title: url, url, snippet: url, quality: "medium" }));
}

describe("web_search disk cache", () => {
  let directory = "";
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-web-search-cache-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("survives a simulated restart within the TTL", async () => {
    let now = 1_000;
    const first = makeCache(directory, () => now);
    first.set("query:a", results("https://example.com/a"), now + DAY_MS);

    now = 2_000;
    const second = makeCache(directory, () => now);
    const loaded = second.get("query:a");

    expect(loaded).toBeDefined();
    expect(loaded?.map((result) => result.url)).toEqual(["https://example.com/a"]);
    expect(loaded?.[0]?.quality).toBe("medium");
  });

  it("treats an expired on-disk entry as a miss and removes its file", async () => {
    let now = 1_000;
    const first = makeCache(directory, () => now);
    first.set("query:exp", results("https://example.com/exp"), now + 1_000);

    now = 5_000;
    const second = makeCache(directory, () => now);
    expect(second.get("query:exp")).toBeUndefined();

    const files = await readdir(directory);
    expect(files).not.toContain(stableKeyHash("query:exp"));
  });

  it("deletes backing files when entries are evicted by the count limit", async () => {
    let now = 0;
    const cache = makeCache(directory, () => now);
    for (const key of ["a", "b", "c", "d"]) {
      cache.set(key, results(`https://example.com/${key}`), now + DAY_MS);
    }

    expect(cache.size).toBe(3);
    const files = await readdir(directory);
    expect(files).not.toContain(stableKeyHash("a"));
    expect(files).toContain(stableKeyHash("d"));
  });

  it("treats corrupt files as a miss without throwing", async () => {
    let now = 0;
    const first = makeCache(directory, () => now);
    first.set("query:c", results("https://example.com/c"), now + DAY_MS);

    const path = join(directory, stableKeyHash("query:c"));
    await writeFile(path, "this is not valid cache data", "utf8");

    const second = makeCache(directory, () => now);
    expect(() => second.get("query:c")).not.toThrow();
    expect(second.get("query:c")).toBeUndefined();
  });

  it("rejects individually oversized entries and stores nothing", () => {
    const cache = makeCache(directory);
    const huge: SearchResult[] = [
      {
        title: "big",
        url: "https://example.com/big",
        snippet: "y".repeat(2_000_000),
        quality: "low",
      },
    ];
    expect(cache.set("big", huge, Date.now() + DAY_MS)).toBe(false);
    expect(cache.get("big")).toBeUndefined();
  });

  it("writes a private 0600 backing file in a 0700 directory on set", async () => {
    const cache = makeCache(directory);
    cache.set("query:w", results("https://example.com/w"), Date.now() + DAY_MS);

    const filePath = join(directory, stableKeyHash("query:w"));
    const fileStat = await stat(filePath);
    expect(fileStat.isFile()).toBe(true);
    expect(fileStat.mode & 0o777).toBe(0o600);

    const dirStat = await stat(directory);
    expect(dirStat.mode & 0o777).toBe(0o700);
  });

  it("hashes keys into collision-resistant, filesystem-safe names", () => {
    const key = JSON.stringify({ provider: "brave", mode: "web", query: "a b", count: 5 });
    expect(stableKeyHash(key)).not.toContain("/");
    expect(stableKeyHash(key)).not.toContain(":");
    expect(stableKeyHash(key)).toBe(stableKeyHash(key));
    expect(stableKeyHash("a")).not.toBe(stableKeyHash("b"));
  });
});
