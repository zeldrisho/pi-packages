import { describe, expect, it } from "vite-plus/test";
import { ExpiringLruCache } from "../src/cache";

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

  it("evicts entries until the aggregate byte limit is satisfied", () => {
    const cache = new ExpiringLruCache<string, string>(10, 5, sizeOf, () => 0);
    cache.set("a", "aaa", 100);
    cache.set("b", "bb", 100);
    cache.set("c", "ccc", 100);

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("bb");
    expect(cache.get("c")).toBe("ccc");
    expect(cache.byteSize).toBe(5);
  });

  it("accounts for replacement and expiry deletion", () => {
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
  });

  it("does not retain an individually oversized replacement", () => {
    const cache = new ExpiringLruCache<string, string>(10, 5, sizeOf, () => 0);
    cache.set("a", "small", 100);

    expect(cache.set("a", "larger", 100)).toBe(false);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0);
    expect(cache.byteSize).toBe(0);
  });
});
