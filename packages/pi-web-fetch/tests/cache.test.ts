import { describe, expect, it } from "vite-plus/test";
import { canonicalKey, ExpiringLruCache } from "../src/cache";

const sizeOf = (value: string): number => new TextEncoder().encode(value).byteLength;

describe("ExpiringLruCache", () => {
  it("evicts the least recently used entry at the count limit", () => {
    const cache = new ExpiringLruCache<string, string>(2, 100, sizeOf, () => 0);
    cache.set("a", "a", 100);
    cache.set("b", "b", 100);
    expect(cache.get("a")).toBe("a");
    cache.set("c", "c", 100);

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("a");
    expect(cache.get("c")).toBe("c");
    expect(cache.size).toBe(2);
  });

  it("evicts least-recently-used entries until the aggregate byte limit is satisfied", () => {
    const cache = new ExpiringLruCache<string, string>(10, 8, sizeOf, () => 0);
    cache.set("a", "aa", 100);
    cache.set("b", "bb", 100);
    cache.set("c", "cccc", 100);
    expect(cache.get("a")).toBe("aa");

    cache.set("d", "ddddd", 100);

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBeUndefined();
    expect(cache.get("a")).toBe("aa");
    expect(cache.get("d")).toBe("ddddd");
    expect(cache.byteSize).toBe(7);
  });

  it("updates byte accounting as entries are replaced, expire, or become too large", () => {
    let now = 0;
    const cache = new ExpiringLruCache<string, string>(10, 10, sizeOf, () => now);
    cache.set("a", "1234", 10);
    cache.set("a", "1", 10);
    cache.set("b", "123", 5);
    expect(cache.byteSize).toBe(4);

    now = 5;
    expect(cache.get("b")).toBeUndefined();
    expect(cache.byteSize).toBe(1);
    expect(cache.get("a")).toBe("1");

    expect(cache.set("a", "oversized value", 10)).toBe(false);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0);
    expect(cache.byteSize).toBe(0);
  });
});

describe("canonical cache keys", () => {
  it("sorts nested object keys but preserves array order and values", () => {
    const a = canonicalKey({ z: [{ b: 2, a: 1 }], a: true });
    expect(a).toMatch(/^[a-f0-9]{64}$/u);
    expect(a).toBe(canonicalKey({ a: true, z: [{ a: 1, b: 2 }] }));
    expect(a).not.toBe(canonicalKey({ a: true, z: [{ a: 1, b: 3 }] }));
    expect(canonicalKey([1, 2])).not.toBe(canonicalKey([2, 1]));
    expect(canonicalKey({ a: undefined })).toBe(canonicalKey({}));
  });
});
