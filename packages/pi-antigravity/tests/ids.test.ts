import { describe, expect, it } from "vite-plus/test";

import { int64SessionId, resolveIdentity, stableUuid } from "../src/ids";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const INT64_MIN = -(2n ** 63n);

const INT64_MAX = 2n ** 63n - 1n;

describe("stable uuid", () => {
  it("derives the same uuid from the same seed", () => {
    expect(stableUuid("session-1")).toBe(stableUuid("session-1"));
  });

  it("derives a different uuid for a different seed", () => {
    expect(stableUuid("session-1")).not.toBe(stableUuid("session-2"));
  });

  it("produces a version 8 UUID-shaped identifier", () => {
    expect(stableUuid("anything")).toMatch(UUID_PATTERN);
    expect(stableUuid("anything")[14]).toBe("8");
  });
});

describe("session id", () => {
  it("produces an int64 string for a free-form seed", () => {
    const id = int64SessionId("session-1");

    expect(id).toMatch(/^-?\d+$/);
    expect(BigInt(id)).toBeGreaterThanOrEqual(INT64_MIN);
    expect(BigInt(id)).toBeLessThanOrEqual(INT64_MAX);
  });

  it("keeps an in-range numeric seed as-is", () => {
    expect(int64SessionId("1234")).toBe("1234");
  });

  it("hashes a numeric seed that would overflow int64", () => {
    const id = int64SessionId("99999999999999999999999");

    expect(id).not.toBe("99999999999999999999999");
    expect(BigInt(id)).toBeLessThanOrEqual(INT64_MAX);
  });

  it("is stable per session", () => {
    expect(int64SessionId("session-1")).toBe(int64SessionId("session-1"));
    expect(int64SessionId("session-1")).not.toBe(int64SessionId("session-2"));
  });
});

describe("request identity", () => {
  it("keeps a caller-supplied session id and derives the rest", () => {
    const identity = resolveIdentity("1234");

    expect(identity.sessionId).toBe("1234");
    expect(identity.conversationId).toMatch(UUID_PATTERN);
    expect(identity.trajectoryId).toMatch(UUID_PATTERN);
    expect(identity.conversationId).not.toBe(identity.trajectoryId);
  });

  it("keeps one conversation across turns of the same session", () => {
    const first = resolveIdentity("1234");
    const second = resolveIdentity("1234");

    expect(second.conversationId).toBe(first.conversationId);
    expect(second.trajectoryId).toBe(first.trajectoryId);
  });

  it("separates sessions", () => {
    expect(resolveIdentity("1234").conversationId).not.toBe(resolveIdentity("5678").conversationId);
  });

  it("trims a padded session id", () => {
    expect(resolveIdentity(" 1234 ").conversationId).toBe(resolveIdentity("1234").conversationId);
  });

  it("invents a fresh identity when the caller has no session", () => {
    const first = resolveIdentity(undefined);
    const second = resolveIdentity(undefined);

    expect(first.sessionId).toMatch(/^-?\d+$/);
    expect(first.conversationId).not.toBe(second.conversationId);
  });

  it("ignores a blank session id", () => {
    expect(resolveIdentity("  ").conversationId).not.toBe(resolveIdentity("  ").conversationId);
  });
});
