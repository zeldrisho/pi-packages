import type { ProviderHeaders } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vite-plus/test";

import {
  applyClientHeaders,
  buildClientHeaders,
  buildUserAgent,
  createCanonicalSessionId,
  createSessionSeed,
  PROVIDER_MARKER_HEADER,
  SESSION_HEADER_NAMES,
  sessionIdAgeMs,
  sessionIdCreatedAt,
} from "../src/client-headers";

const CLI_VERSION = "2.1.4";

const SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/u;

function deterministicSeed(offset = 0): Uint8Array {
  return Uint8Array.from({ length: 20 }, (_, index) => (index + offset) % 256);
}

const SESSION_TS_MODULUS = 2 ** 36;

/** Recovers the creation time the CLI encodes in the identifier's hex half. */
function decodeSessionTimestamp(id: string): number {
  const encoded = BigInt(`0x${id.slice(4, 16)}`);

  return Number((~encoded & 0xff_ff_ff_ff_ff_ffn) >> 12n);
}

describe("opencode session identity", () => {
  it("encodes the creation time, counter bits, and seed in a canonical session ID", () => {
    const now = 1_793_000_000_000;
    const seed = deterministicSeed();
    const id = createCanonicalSessionId(seed, now);

    expect(id).toMatch(SESSION_PATTERN);
    expect(id.slice(4, 16).endsWith("ffe")).toBe(true);
    expect(decodeSessionTimestamp(id)).toBe(now % SESSION_TS_MODULUS);
    expect(createCanonicalSessionId(seed, now)).toBe(id);
    expect(createCanonicalSessionId(deterministicSeed(1), now)).not.toBe(id);
    expect(decodeSessionTimestamp(createCanonicalSessionId(seed, now + 60_000))).toBe(
      (now + 60_000) % SESSION_TS_MODULUS,
    );
  });

  it("defaults the creation time to now", () => {
    const before = Date.now() % SESSION_TS_MODULUS;
    const id = createCanonicalSessionId(deterministicSeed());
    const stamp = decodeSessionTimestamp(id);
    const elapsed = (stamp - before + SESSION_TS_MODULUS) % SESSION_TS_MODULUS;

    expect(elapsed).toBeLessThan(5000);
  });

  it("rejects a seed that is too short", () => {
    expect(() => createCanonicalSessionId(new Uint8Array(19))).toThrow(/at least 20 bytes/u);
  });

  it("returns no age for malformed identifiers", () => {
    expect(sessionIdCreatedAt("ses_xyz")).toBeUndefined();
    expect(sessionIdCreatedAt("ses_000000000000")).toBeUndefined();
    expect(sessionIdAgeMs("not-a-session", Date.now())).toBeUndefined();
  });

  it("recovers creation time and signed ages across the timestamp wrap", () => {
    const beforeWrap = createCanonicalSessionId(deterministicSeed(), SESSION_TS_MODULUS - 500);
    const afterWrap = createCanonicalSessionId(deterministicSeed(), SESSION_TS_MODULUS + 500);

    expect(sessionIdCreatedAt(beforeWrap)).toBe(SESSION_TS_MODULUS - 500);
    expect(sessionIdCreatedAt(afterWrap)).toBe(500);
    expect(sessionIdAgeMs(afterWrap, SESSION_TS_MODULUS + 1000)).toBe(500);
    expect(sessionIdAgeMs(beforeWrap, SESSION_TS_MODULUS + 500)).toBe(1000);
    expect(sessionIdAgeMs(afterWrap, SESSION_TS_MODULUS - 500)).toBe(-1000);
  });

  it("keeps the suffix well formed when seed bytes are rejected", () => {
    const id = createCanonicalSessionId(Uint8Array.from({ length: 20 }, () => 0xff));

    expect(id).toMatch(SESSION_PATTERN);
    expect(id).toHaveLength(30);
  });

  it("builds client headers with an identity derived from a fresh seed", () => {
    const seed = createSessionSeed();
    expect(seed).toHaveLength(20);
    const sessionId = createCanonicalSessionId(seed);

    const headers = buildClientHeaders(sessionId, CLI_VERSION);

    expect(headers["User-Agent"]).toBe(`opencode/latest/${CLI_VERSION}/cli`);
    expect(headers["x-opencode-client"]).toBe("cli");
    expect(headers["x-opencode-project"]).toBe("global");
    expect(headers[PROVIDER_MARKER_HEADER]).toBe("1");

    for (const name of SESSION_HEADER_NAMES) {
      expect(headers[name]).toBe(sessionId);
    }
  });

  it("updates marked request headers and removes the v1 request header", () => {
    const sessionId = createCanonicalSessionId(deterministicSeed(1));

    const headers = {
      "x-pi-opencode-free": "1",
      "user-agent": "curl/8",
      "User-Agent": "old-agent",
      "X-Opencode-Request": "legacy",
      "x-opencode-session": "ses_old",
      "x-opencode-session-id": "ses_old",
      "x-session-affinity": "ses_old",
      "x-session-id": "ses_old",
      "x-other": "keep",
    } satisfies ProviderHeaders;

    expect(applyClientHeaders(headers, sessionId, CLI_VERSION)).toBe(true);
    expect(headers["User-Agent"]).toBe(buildUserAgent(CLI_VERSION));
    expect(headers["user-agent"]).toBeUndefined();
    expect(headers["X-Opencode-Request"]).toBeUndefined();
    expect(headers["x-other"]).toBe("keep");

    for (const name of SESSION_HEADER_NAMES) {
      expect(headers[name]).toBe(sessionId);
    }
  });

  it("leaves requests from other providers untouched", () => {
    const headers = {
      Authorization: "Bearer secret",
      "x-opencode-session": "ses_other",
    } satisfies ProviderHeaders;

    expect(applyClientHeaders(headers, createCanonicalSessionId(), CLI_VERSION)).toBe(false);
    expect(headers).toEqual({
      Authorization: "Bearer secret",
      "x-opencode-session": "ses_other",
    });
  });
});
