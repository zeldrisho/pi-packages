import { describe, expect, it } from "vite-plus/test";

import {
  buildAuthUrl,
  createPkcePair,
  getApiKey,
  parseApiKey,
  parsePastedCallback,
  redirectUri,
} from "../src/oauth";
import { extractProjectId, stableProjectId } from "../src/project";

const STATE = "state-value";

const CLIENT = { id: "test-client-id", secret: "test-client-secret" };

describe("PKCE and authorization URL", () => {
  it("uses the discovered OAuth client in the authorization URL", () => {
    const url = new URL(
      buildAuthUrl({ verifier: "verifier", challenge: "challenge" }, STATE, CLIENT),
    );

    expect(url.searchParams.get("client_id")).toBe("test-client-id");
  });

  it("derives a deterministic challenge from fixed randomness", () => {
    const random = (size: number): Uint8Array => new Uint8Array(size).fill(7);
    const first = createPkcePair(random);
    const second = createPkcePair(random);

    expect(first).toEqual(second);
    expect(first.verifier.length).toBeGreaterThanOrEqual(43);
    expect(first.challenge).not.toBe(first.verifier);
    expect(first.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("builds an offline authorization URL with the required scopes", () => {
    const url = new URL(
      buildAuthUrl({ verifier: "verifier", challenge: "challenge" }, STATE, CLIENT),
    );

    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe("challenge");
    expect(url.searchParams.get("state")).toBe(STATE);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("redirect_uri")).toBe(redirectUri());

    const scope = url.searchParams.get("scope") ?? "";

    expect(scope).toContain("https://www.googleapis.com/auth/aicode");
    expect(scope).toContain("https://www.googleapis.com/auth/cloud-platform");
  });

  it("keeps the code verifier out of the authorization URL", () => {
    const url = buildAuthUrl(
      { verifier: "secret-verifier", challenge: "challenge" },
      STATE,
      CLIENT,
    );

    expect(url).not.toContain("secret-verifier");
  });
});

describe("pasted callback parsing", () => {
  it("accepts a full callback URL", () => {
    expect(
      parsePastedCallback(
        "http://localhost:51121/oauth-callback?state=state-value&code=4/abc",
        STATE,
      ),
    ).toBe("4/abc");
  });

  it("accepts a bare query string", () => {
    expect(parsePastedCallback("code=4/abc&state=state-value", STATE)).toBe("4/abc");
  });

  it("rejects a callback from another sign-in", () => {
    expect(() =>
      parsePastedCallback("http://localhost:51121/oauth-callback?state=other&code=4/abc", STATE),
    ).toThrow(/different sign-in/);
  });

  it("rejects a callback without a code", () => {
    expect(() =>
      parsePastedCallback("http://localhost:51121/oauth-callback?state=state-value", STATE),
    ).toThrow(/missing `code`/);
  });

  it("reports an OAuth error delivered through the callback", () => {
    expect(() =>
      parsePastedCallback("http://localhost:51121/oauth-callback?error=access_denied", STATE),
    ).toThrow(/access_denied/);
  });

  it("rejects empty input", () => {
    expect(() => parsePastedCallback("   ", STATE)).toThrow(/Nothing pasted/);
  });
});

describe("credential round-trip", () => {
  it("encodes the access token and project id", () => {
    const apiKey = getApiKey({
      access: "token-value",
      refresh: "refresh-value",
      expires: 1,
      projectId: "project-value",
    });

    expect(parseApiKey(apiKey)).toEqual({ token: "token-value", projectId: "project-value" });
    expect(apiKey).not.toContain("refresh-value");
  });

  it("falls back to a stable project id when none is stored", () => {
    const apiKey = getApiKey({ access: "token-value", refresh: "refresh-value", expires: 1 });

    expect(parseApiKey(apiKey).projectId).toBe(stableProjectId("antigravity"));
  });

  it("rejects missing and malformed credentials without echoing them", () => {
    expect(() => parseApiKey(undefined)).toThrow(/No Antigravity credentials/);
    expect(() => parseApiKey("")).toThrow(/No Antigravity credentials/);
    expect(() => parseApiKey("not-json")).toThrow(/Invalid Antigravity credentials/);
    expect(() => parseApiKey(JSON.stringify({ token: "only-token" }))).toThrow(
      /Invalid Antigravity credentials/,
    );
    expect(() => parseApiKey(JSON.stringify({ token: 1, projectId: 2 }))).toThrow(
      /Invalid Antigravity credentials/,
    );
  });
});

describe("project discovery payloads", () => {
  it("reads the direct project field", () => {
    expect(extractProjectId({ projectId: "direct-project" })).toBe("direct-project");
  });

  it("reads a nested project object", () => {
    expect(extractProjectId({ cloudaicompanionProject: { id: "nested-project" } })).toBe(
      "nested-project",
    );
  });

  it("reads a project list", () => {
    expect(extractProjectId({ projects: [{ id: "listed-project" }] })).toBe("listed-project");
  });

  it("ignores payloads without a project id", () => {
    expect(extractProjectId({ currentTier: "standard" })).toBeUndefined();
    expect(extractProjectId(["array"])).toBeUndefined();
    expect(extractProjectId(null)).toBeUndefined();
    expect(extractProjectId("string")).toBeUndefined();
  });

  it("derives a stable UUID-shaped project id from a seed", () => {
    const first = stableProjectId("example@googlemail.com");
    const second = stableProjectId("example@googlemail.com");

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(stableProjectId("other")).not.toBe(first);
  });
});
