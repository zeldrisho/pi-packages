import type { ProviderHeaders } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vite-plus/test";

import {
  applyFingerprintHeaders,
  buildFingerprintHeaders,
  buildUserAgent,
  createCanonicalSessionId,
  createSessionSeed,
  DEFAULT_CLI_VERSION,
  FINGERPRINT_MARKER_HEADER,
  READ_TOOL,
  resolveCliVersion,
  SESSION_HEADER_NAMES,
} from "../src/fingerprint";

const SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/u;

function deterministicSeed(offset = 0): Uint8Array {
  return Uint8Array.from({ length: 20 }, (_, index) => (index + offset) % 256);
}

describe("opencode session identity", () => {
  it("renders a canonical session id with the pinned counter bits", () => {
    const id = createCanonicalSessionId(deterministicSeed());

    expect(id).toMatch(SESSION_PATTERN);
    expect(id).toHaveLength(30);
    expect(id.slice(4, 16).endsWith("ffe")).toBe(true);
  });

  it("is deterministic for a fixed seed and changes with different bytes", () => {
    expect(createCanonicalSessionId(deterministicSeed())).toBe(
      createCanonicalSessionId(deterministicSeed()),
    );
    expect(createCanonicalSessionId(deterministicSeed(1))).not.toBe(
      createCanonicalSessionId(deterministicSeed()),
    );
  });

  it("rejects a seed that is too short", () => {
    expect(() => createCanonicalSessionId(new Uint8Array(19))).toThrow(/at least 20 bytes/u);
  });

  it("creates a fresh twenty-byte seed", () => {
    const seed = createSessionSeed();

    expect(seed).toBeInstanceOf(Uint8Array);
    expect(seed).toHaveLength(20);
  });

  it("builds headers for the full v2 fingerprint", () => {
    const sessionId = createCanonicalSessionId(deterministicSeed());

    const headers = buildFingerprintHeaders(sessionId, DEFAULT_CLI_VERSION);

    expect(headers["User-Agent"]).toBe(buildUserAgent(DEFAULT_CLI_VERSION));
    expect(headers["x-opencode-client"]).toBe("cli");
    expect(headers["x-opencode-project"]).toBe("global");
    expect(headers[FINGERPRINT_MARKER_HEADER]).toBe("1");

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

    expect(applyFingerprintHeaders(headers, sessionId, DEFAULT_CLI_VERSION)).toBe(true);
    expect(headers["User-Agent"]).toBe(buildUserAgent(DEFAULT_CLI_VERSION));
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

    expect(applyFingerprintHeaders(headers, createCanonicalSessionId(), DEFAULT_CLI_VERSION)).toBe(
      false,
    );
    expect(headers).toEqual({
      Authorization: "Bearer secret",
      "x-opencode-session": "ses_other",
    });
  });

  it("uses a major-2 compatibility version by default", () => {
    expect(resolveCliVersion({})).toBe(DEFAULT_CLI_VERSION);
    expect(DEFAULT_CLI_VERSION.startsWith("2.")).toBe(true);
    expect(buildUserAgent(DEFAULT_CLI_VERSION)).toBe(`opencode/latest/${DEFAULT_CLI_VERSION}/cli`);
  });

  it("accepts a valid client version override", () => {
    expect(resolveCliVersion({ OPENCODE_FREE_CLI_VERSION: " 2.1.3 " })).toBe("2.1.3");
    expect(resolveCliVersion({ OPENCODE_FREE_CLI_VERSION: "2.1" })).toBe("2.1");
  });

  it("ignores malformed client version overrides", () => {
    for (const value of ["latest", "2", "2.1.3-beta", "v2.1.3", ""]) {
      expect(resolveCliVersion({ OPENCODE_FREE_CLI_VERSION: value })).toBe(DEFAULT_CLI_VERSION);
    }
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
