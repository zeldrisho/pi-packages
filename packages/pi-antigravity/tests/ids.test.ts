import { describe, expect, it } from "vite-plus/test";

import { int64SessionId, resolveIdentity, stableUuid } from "../src/ids";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const INT64_MIN = -(2n ** 63n);

const INT64_MAX = 2n ** 63n - 1n;

describe("stable uuid", () => {
  it("derives a stable version 8 UUID from the seed", () => {
    const id = stableUuid("session-1");

    expect(id).toMatch(UUID_PATTERN);
    expect(id[14]).toBe("8");
    expect(stableUuid("session-1")).toBe(id);
    expect(stableUuid("session-2")).not.toBe(id);
  });
});

describe("session id", () => {
  it("derives a stable int64 string for a free-form seed", () => {
    const id = int64SessionId("session-1");

    expect(id).toMatch(/^-?\d+$/);
    expect(BigInt(id)).toBeGreaterThanOrEqual(INT64_MIN);
    expect(BigInt(id)).toBeLessThanOrEqual(INT64_MAX);
    expect(int64SessionId("session-1")).toBe(id);
    expect(int64SessionId("session-2")).not.toBe(id);
  });

  it("keeps an in-range numeric seed as-is", () => {
    expect(int64SessionId("1234")).toBe("1234");
  });

  it("hashes a numeric seed that would overflow int64", () => {
    const id = int64SessionId("99999999999999999999999");

    expect(id).not.toBe("99999999999999999999999");
    expect(BigInt(id)).toBeLessThanOrEqual(INT64_MAX);
  });
});

describe("request identity", () => {
  it("derives a stable identity scoped to the caller's session", () => {
    const identity = resolveIdentity("1234");

    expect(identity.sessionId).toBe("1234");
    expect(identity.conversationId).toMatch(UUID_PATTERN);
    expect(identity.trajectoryId).toMatch(UUID_PATTERN);
    expect(identity.conversationId).not.toBe(identity.trajectoryId);
    expect(resolveIdentity("1234")).toEqual(identity);
    expect(resolveIdentity(" 1234 ")).toEqual(identity);
    expect(resolveIdentity("5678").conversationId).not.toBe(identity.conversationId);
  });

  it("invents a fresh identity without a usable caller session", () => {
    const first = resolveIdentity(undefined);
    const second = resolveIdentity(undefined);

    expect(first.sessionId).toMatch(/^-?\d+$/);
    expect(first.conversationId).not.toBe(second.conversationId);
    expect(resolveIdentity("  ").conversationId).not.toBe(resolveIdentity("  ").conversationId);
  });
});
