import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { canonicalKey, ExpiringLruCache, stableKeyHash, type CachePersistence } from "../src/cache";
import type { CompleteDocument } from "../src/document/content.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;

const encoder = new TextEncoder();

const decoder = new TextDecoder();

function makePersistence(directory: string): CachePersistence<string, CompleteDocument> {
  return {
    directory,
    serialize: (document) => encoder.encode(JSON.stringify(document)),
    // SAFETY: the on-disk bytes are produced by this same serializer, so they always
    // decode back into a CompleteDocument.
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

  it("reloads a private on-disk entry after restart, then removes it at expiry", async () => {
    let now = 1_000;
    const key = "https://example.com/a/b?c=1&d=2";
    const first = makeCache(directory, () => now);
    first.set(key, document(key, "alpha"), now + DAY_MS);

    const filename = stableKeyHash(key);
    expect(filename).toMatch(/^[a-f0-9]{64}$/u);
    const fileStat = await stat(join(directory, filename));
    expect(fileStat.isFile()).toBe(true);
    expect(fileStat.mode & 0o777).toBe(0o600);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);

    now = 2_000;
    const second = makeCache(directory, () => now);
    expect(second.get(key)).toMatchObject({ markdown: "alpha", url: key });

    now = 1_000 + DAY_MS;
    const expired = makeCache(directory, () => now);
    expect(expired.get(key)).toBeUndefined();
    expect(await readdir(directory)).toEqual([]);
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

  it("treats corrupt, truncated, and oversized cache files as misses", async () => {
    const cache = makeCache(directory, () => 0);
    const header = Buffer.alloc(8);
    header.writeBigUInt64BE(BigInt(DAY_MS));

    const samples = {
      corrupt: Buffer.concat([header, Buffer.from("invalid JSON")]),
      truncated: header.subarray(0, 4),
      oversized: Buffer.concat([
        header,
        encoder.encode(JSON.stringify(document("oversized", "z".repeat(1_000_001)))),
      ]),
    };

    for (const [key, bytes] of Object.entries(samples)) {
      await writeFile(join(directory, stableKeyHash(key)), bytes);
      expect.soft(cache.get(key), key).toBeUndefined();
    }

    expect(await readdir(directory)).toEqual([]);
  });

  it("refetches fresh persisted HTML from before the extraction cleanup but retains raw text", async () => {
    vi.stubEnv("XDG_CACHE_HOME", directory);

    try {
      const now = Date.now();
      const cache = makeCache(join(directory, "pi-web-fetch"));
      const htmlUrl = "https://example.com/discussion";
      const rawUrl = "https://example.com/readme.txt";
      cache.set(
        canonicalKey({ url: htmlUrl }),
        {
          ...document(htmlUrl, "stale interface flags"),
          contentType: "text/html",
          extractor: "defuddle",
          cachedAt: now,
          markdownPolicyVersion: 2,
          validators: { etag: '"unchanged"' },
        },
        now + DAY_MS,
      );
      cache.set(canonicalKey({ url: rawUrl }), document(rawUrl, "cached raw text"), now + DAY_MS);

      const { executeWebFetch } = await import("../src/service.ts");

      const dependencies = {
        validateUrl: async (value: string | URL) => {
          throw new Error(`unexpected request for ${value}`);
        },
      };

      await expect(
        executeWebFetch({ url: htmlUrl }, undefined, undefined, dependencies),
      ).rejects.toThrow(`unexpected request for ${htmlUrl}`);
      const raw = await executeWebFetch({ url: rawUrl }, undefined, undefined, dependencies);
      expect(raw.details.cacheStatus).toBe("hit");
      expect(raw.content[0].text).toContain("cached raw text");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects individually oversized entries and stores nothing", () => {
    const cache = makeCache(directory);
    expect(cache.set("big", document("big", "y".repeat(2_000_000)), Date.now() + DAY_MS)).toBe(
      false,
    );
    expect(cache.get("big")).toBeUndefined();
  });
});
