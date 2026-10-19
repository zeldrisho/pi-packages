import { describe, expect, it } from "vite-plus/test";
import { hasAnubisMarkers, parseAnubisChallenge } from "../../src/challenges/anubis.ts";

interface ChallengeOverrides {
  version?: string;
  basePrefix?: string;
  publicUrl?: string;
  challenge?: string;
}

function page(
  overrides: ChallengeOverrides = {},
  challenge = '{"rules":{"algorithm":"fast","difficulty":4},"challenge":{"id":"cid","method":"fast","randomData":"deadbeef","difficulty":4}}',
): string {
  const version = JSON.stringify(overrides.version ?? "v1.26.2");
  const basePrefix = JSON.stringify(overrides.basePrefix ?? "");
  const publicUrl = JSON.stringify(overrides.publicUrl ?? "");

  return [
    "<html><head>",
    `<script id="anubis_version" type="application/json">${version}</script>`,
    `<script id="anubis_base_prefix" type="application/json">${basePrefix}</script>`,
    `<script id="anubis_public_url" type="application/json">${publicUrl}</script>`,
    `<script id="anubis_challenge" type="application/json">${overrides.challenge ?? challenge}</script>`,
    "</head><body></body></html>",
  ].join("");
}

const pageUrl = new URL("https://example.test/protected");

describe("hasAnubisMarkers", () => {
  it("detects challenge and version scripts", () => {
    expect(hasAnubisMarkers('<script id="anubis_challenge">')).toBe(true);
    expect(hasAnubisMarkers('<script id="anubis_version">')).toBe(true);
    expect(hasAnubisMarkers("<html><body>Hello</body></html>")).toBe(false);
  });
});

describe("parseAnubisChallenge", () => {
  it("parses a well-formed challenge", () => {
    expect(parseAnubisChallenge(page(), pageUrl)).toEqual({
      id: "cid",
      method: "fast",
      randomData: "deadbeef",
      difficulty: 4,
      version: "v1.26.2",
      basePrefix: "",
      extensions: [],
    });
  });

  it("falls back to rule algorithm and difficulty", () => {
    const challenge =
      '{"rules":{"algorithm":"sha256","difficulty":20},"challenge":{"id":"cid","randomData":"00"}}';

    expect(parseAnubisChallenge(page({}, challenge), pageUrl)).toMatchObject({
      method: "sha256",
      difficulty: 20,
    });
  });

  it("parses supported extensions", () => {
    const challenge =
      '{"challenge":{"id":"cid","method":"fast","randomData":"00","difficulty":1,"extensions":["css-load"]}}';

    expect(parseAnubisChallenge(page({}, challenge), pageUrl)?.extensions).toEqual(["css-load"]);
  });

  it("normalizes a nested base prefix", () => {
    expect(parseAnubisChallenge(page({ basePrefix: "/anubis/" }), pageUrl)?.basePrefix).toBe(
      "/anubis",
    );
  });

  it("returns undefined for a page without markers", () => {
    expect(parseAnubisChallenge("<html><body>Hello</body></html>", pageUrl)).toBeUndefined();
  });

  it("returns undefined when the version script is missing", () => {
    const html = page().replace(/<script id="anubis_version"[^<]*<\/script>/, "");

    expect(parseAnubisChallenge(html, pageUrl)).toBeUndefined();
  });

  it("returns undefined for a null challenge payload", () => {
    expect(parseAnubisChallenge(page({ challenge: "null" }), pageUrl)).toBeUndefined();
  });

  it("returns undefined for malformed challenge JSON", () => {
    expect(parseAnubisChallenge(page({ challenge: "{not json" }), pageUrl)).toBeUndefined();
  });

  it("returns undefined for a cross-origin public URL", () => {
    expect(
      parseAnubisChallenge(page({ publicUrl: "https://other.test/" }), pageUrl),
    ).toBeUndefined();
  });

  it.each(["//evil.test", "/a/..", "/a/%2e%2e", "relative", "/a?b=1"])(
    "returns undefined for an unsafe base prefix %s",
    (basePrefix) => {
      expect(parseAnubisChallenge(page({ basePrefix }), pageUrl)).toBeUndefined();
    },
  );

  it("rejects a non-string difficulty", () => {
    const challenge =
      '{"challenge":{"id":"cid","method":"fast","randomData":"00","difficulty":"4"}}';

    expect(parseAnubisChallenge(page({}, challenge), pageUrl)).toBeUndefined();
  });

  it("rejects an over-long identifier", () => {
    const challenge = JSON.stringify({
      challenge: { id: "a".repeat(300), method: "fast", randomData: "00", difficulty: 1 },
    });

    expect(parseAnubisChallenge(page({}, challenge), pageUrl)).toBeUndefined();
  });

  it("rejects control characters in the identifier", () => {
    const challenge = JSON.stringify({
      challenge: { id: "bad\u0000id", method: "fast", randomData: "00", difficulty: 1 },
    });

    expect(parseAnubisChallenge(page({}, challenge), pageUrl)).toBeUndefined();
  });

  it("rejects non-string extensions", () => {
    const challenge = JSON.stringify({
      challenge: { id: "cid", method: "fast", randomData: "00", difficulty: 1, extensions: [1] },
    });

    expect(parseAnubisChallenge(page({}, challenge), pageUrl)).toBeUndefined();
  });

  it("rejects an unknown method shape", () => {
    const challenge = JSON.stringify({
      challenge: { id: "cid", method: 5, randomData: "00", difficulty: 1 },
    });

    expect(parseAnubisChallenge(page({}, challenge), pageUrl)).toBeUndefined();
  });
});
