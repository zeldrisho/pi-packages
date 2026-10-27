import type { ProviderHeaders } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vite-plus/test";

import {
  applyClientHeaders,
  buildClientHeaders,
  buildUserAgent,
  createCanonicalSessionId,
  createSessionSeed,
  PROVIDER_MARKER_HEADER,
  READ_TOOL,
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

  return Number((~encoded & 0xffffffffffffn) >> 12n);
}

describe("opencode session identity", () => {
  it("renders a canonical session id with the pinned counter bits", () => {
    const id = createCanonicalSessionId(deterministicSeed());

    expect(id).toMatch(SESSION_PATTERN);
    expect(id).toHaveLength(30);
    expect(id.slice(4, 16).endsWith("ffe")).toBe(true);
  });

  it("is deterministic for a fixed seed and changes with different bytes", () => {
    const now = 1_793_000_000_000;

    expect(createCanonicalSessionId(deterministicSeed(), now)).toBe(
      createCanonicalSessionId(deterministicSeed(), now),
    );
    expect(createCanonicalSessionId(deterministicSeed(1), now)).not.toBe(
      createCanonicalSessionId(deterministicSeed(), now),
    );
  });

  it("encodes the creation time in the identifier", () => {
    const now = 1_793_000_000_000;
    const id = createCanonicalSessionId(deterministicSeed(), now);

    expect(decodeSessionTimestamp(id)).toBe(now % SESSION_TS_MODULUS);
  });

  it("tracks the wall clock instead of the seed", () => {
    const first = createCanonicalSessionId(deterministicSeed(), 1_700_000_000_000);
    const second = createCanonicalSessionId(deterministicSeed(), 1_700_000_060_000);

    expect(decodeSessionTimestamp(second) - decodeSessionTimestamp(first)).toBe(60_000);
  });

  it("defaults the creation time to now", () => {
    const before = Date.now() % SESSION_TS_MODULUS;
    const id = createCanonicalSessionId(deterministicSeed());
    const stamp = decodeSessionTimestamp(id);
    const elapsed = (stamp - before + SESSION_TS_MODULUS) % SESSION_TS_MODULUS;

    expect(elapsed).toBeLessThan(5_000);
  });

  it("rejects a seed that is too short", () => {
    expect(() => createCanonicalSessionId(new Uint8Array(19))).toThrow(/at least 20 bytes/u);
  });

  it("recovers the creation time and age of an identifier", () => {
    const now = 1_793_000_000_000;
    const id = createCanonicalSessionId(deterministicSeed(), now - 90_000);

    expect(sessionIdCreatedAt(id)).toBe((now - 90_000) % SESSION_TS_MODULUS);
    expect(sessionIdAgeMs(id, now)).toBe(90_000);
    expect(sessionIdAgeMs(id, now - 60_000)).toBe(30_000);
  });

  it("reads future-dated identifiers as negative ages across the wrap", () => {
    const now = 1_793_000_000_000;
    const id = createCanonicalSessionId(deterministicSeed(), now + 45_000);

    expect(sessionIdAgeMs(id, now)).toBe(-45_000);
  });

  it("returns no age for malformed identifiers", () => {
    expect(sessionIdCreatedAt("ses_xyz")).toBeUndefined();
    expect(sessionIdCreatedAt("ses_000000000000")).toBeUndefined();
    expect(sessionIdAgeMs("not-a-session", Date.now())).toBeUndefined();
  });

  it("measures ages on both sides of the timestamp wrap", () => {
    const beforeWrap = createCanonicalSessionId(deterministicSeed(), SESSION_TS_MODULUS - 500);
    const afterWrap = createCanonicalSessionId(deterministicSeed(), SESSION_TS_MODULUS + 500);

    expect(sessionIdAgeMs(beforeWrap, SESSION_TS_MODULUS + 500)).toBe(1_000);
    expect(sessionIdAgeMs(afterWrap, SESSION_TS_MODULUS - 500)).toBe(-1_000);
  });

  it("keeps the suffix well formed when seed bytes are rejected", () => {
    const id = createCanonicalSessionId(Uint8Array.from({ length: 20 }, () => 0xff));

    expect(id).toMatch(SESSION_PATTERN);
    expect(id).toHaveLength(30);
  });

  it("creates a fresh twenty-byte seed", () => {
    const seed = createSessionSeed();

    expect(seed).toBeInstanceOf(Uint8Array);
    expect(seed).toHaveLength(20);
  });

  it("builds the full client header set", () => {
    const sessionId = createCanonicalSessionId(deterministicSeed());

    const headers = buildClientHeaders(sessionId, CLI_VERSION);

    expect(headers["User-Agent"]).toBe(buildUserAgent(CLI_VERSION));
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

  it("builds the user agent from a resolved client version", () => {
    expect(buildUserAgent(CLI_VERSION)).toBe(`opencode/latest/${CLI_VERSION}/cli`);
  });

  it("declares the read tool with the v2 CLI schema", () => {
    expect(READ_TOOL.type).toBe("function");
    expect(READ_TOOL.function.name).toBe("read");
    expect(READ_TOOL.function.parameters.required).toEqual(["path"]);
    expect(READ_TOOL.function.parameters.additionalProperties).toBe(false);
    expect(READ_TOOL.function.strict).toBe(false);
    expect(Object.keys(READ_TOOL.function.parameters.properties)).toEqual([
      "path",
      "offset",
      "limit",
    ]);
  });
});
