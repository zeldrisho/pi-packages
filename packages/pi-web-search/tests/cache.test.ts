import { describe, expect, it } from "vite-plus/test";
import { ExpiringLruCache } from "../src/cache";

const sizeOf = (value: string): number => new TextEncoder().encode(value).byteLength;

describe("search result cache", () => {
  it("evicts least-recently-used entries to enforce the aggregate byte limit", () => {
    const cache = new ExpiringLruCache<string, string>(10, 8, sizeOf, () => 0);
    cache.set("first", "1234", 100);
    cache.set("second", "5678", 100);
    expect(cache.get("first")).toBe("1234");

    cache.set("third", "abcde", 100);

    expect(cache.get("second")).toBeUndefined();
    expect(cache.get("first")).toBeUndefined();
    expect(cache.get("third")).toBe("abcde");
    expect(cache.byteSize).toBe(5);
  });

  it("removes expired entries from byte accounting", () => {
    let now = 0;
    const cache = new ExpiringLruCache<string, string>(10, 10, sizeOf, () => now);
    cache.set("result", "1234", 5);
    now = 5;

    expect(cache.get("result")).toBeUndefined();
    expect(cache.byteSize).toBe(0);
  });
});
