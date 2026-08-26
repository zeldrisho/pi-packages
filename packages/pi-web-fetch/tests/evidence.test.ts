import type { IncomingMessage } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { executeWebFetch, type FetchRemoteDependencies } from "../src/index";
import { classifyContentKind, classifyConfidence } from "../src/service";
import { detectAppShell, normalizeGitHubRawUrl } from "../src/fetch";
import { createFetchHarness } from "./harness";

/** Builds a minimal text/plain HTTP response for offline fetch testing. */
function fakeTextResponse(body: string): IncomingMessage {
  const buffer = Buffer.from(body);
  const iterator = {
    async *[Symbol.asyncIterator]() {
      yield buffer;
    },
  };
  // SAFETY: the literal satisfies IncomingMessage's stream contract; we set the few
  // fields the tests read (statusCode, headers) immediately above.
  return {
    statusCode: 200,
    headers: { "content-type": "text/plain" },
    destroy() {},
    ...iterator,
  } as IncomingMessage;
}

describe("normalizeGitHubRawUrl", () => {
  it("rewrites blob URLs to raw.githubusercontent.com", () => {
    expect(normalizeGitHubRawUrl("https://github.com/o/r/blob/main/src/x.ts")).toBe(
      "https://raw.githubusercontent.com/o/r/main/src/x.ts",
    );
  });

  it("preserves query strings when rewriting", () => {
    expect(normalizeGitHubRawUrl("https://github.com/o/r/blob/main/x.ts?foo=1")).toBe(
      "https://raw.githubusercontent.com/o/r/main/x.ts?foo=1",
    );
  });

  it("appends /raw to bare gist pages", () => {
    expect(normalizeGitHubRawUrl("https://gist.github.com/user/abc123")).toBe(
      "https://gist.github.com/user/abc123/raw",
    );
    expect(normalizeGitHubRawUrl("https://gist.github.com/user/abc123/")).toBe(
      "https://gist.github.com/user/abc123/raw",
    );
    expect(normalizeGitHubRawUrl("https://gist.github.com/user/abc123?foo=1")).toBe(
      "https://gist.github.com/user/abc123/raw?foo=1",
    );
  });

  it("leaves gist subpages untouched", () => {
    expect(normalizeGitHubRawUrl("https://gist.github.com/user/abc123/revisions")).toBe(
      "https://gist.github.com/user/abc123/revisions",
    );
    expect(normalizeGitHubRawUrl("https://gist.github.com/user/abc123/raw")).toBe(
      "https://gist.github.com/user/abc123/raw",
    );
  });

  it("rewrites tree URLs with file extensions to raw", () => {
    expect(normalizeGitHubRawUrl("https://github.com/o/r/tree/main/src/x.ts")).toBe(
      "https://raw.githubusercontent.com/o/r/main/src/x.ts",
    );
  });

  it("handles owner named tree correctly", () => {
    expect(normalizeGitHubRawUrl("https://github.com/tree/repo/tree/main/file.ts")).toBe(
      "https://raw.githubusercontent.com/tree/repo/main/file.ts",
    );
  });

  it("preserves query strings when rewriting tree URLs", () => {
    expect(normalizeGitHubRawUrl("https://github.com/o/r/tree/main/x.ts?foo=1")).toBe(
      "https://raw.githubusercontent.com/o/r/main/x.ts?foo=1",
    );
  });

  it("leaves non-blob github URLs untouched", () => {
    expect(normalizeGitHubRawUrl("https://github.com/o/r")).toBe("https://github.com/o/r");
    expect(normalizeGitHubRawUrl("https://github.com/o/r/tree/main")).toBe(
      "https://github.com/o/r/tree/main",
    );
  });

  it("leaves non-github URLs untouched", () => {
    expect(normalizeGitHubRawUrl("https://example.com/a/b")).toBe("https://example.com/a/b");
  });

  it("leaves non-https github URLs untouched", () => {
    expect(normalizeGitHubRawUrl("http://github.com/o/r/blob/main/x")).toBe(
      "http://github.com/o/r/blob/main/x",
    );
    expect(normalizeGitHubRawUrl("http://gist.github.com/user/abc123")).toBe(
      "http://gist.github.com/user/abc123",
    );
  });

  it("returns invalid URLs unchanged", () => {
    expect(normalizeGitHubRawUrl("not a url")).toBe("not a url");
  });
});

describe("detectAppShell", () => {
  it("flags consent and bot-wall markers", () => {
    expect(detectAppShell("<title>Please enable JavaScript</title>", "")).toBe(true);
    expect(detectAppShell("Before you continue, consent to cookies", "")).toBe(true);
    expect(detectAppShell("Checking your browser", "")).toBe(true);
  });

  it("flags sparse text relative to a huge raw page", () => {
    expect(detectAppShell(`<html>${"x".repeat(20_000)}</html>`, "tiny")).toBe(true);
  });

  it("does not flag a normal article", () => {
    const raw = `<html><body><article>${"word ".repeat(2000)}</article></body></html>`;
    expect(detectAppShell(raw, "word ".repeat(2000))).toBe(false);
  });

  it("does not flag ordinary prose that merely mentions consent", () => {
    const body = "By continuing you consent to our newsletter and privacy policy. ".repeat(150);
    const raw = "<html><body><article>" + body + "</article></body></html>";
    expect(detectAppShell(raw, body)).toBe(false);
  });

  it("does not flag a content-rich page dominated by script markup", () => {
    const script = "<script>" + "x".repeat(60_000) + "</script>";
    const body = "Lorem ipsum dolor sit amet. ".repeat(400);
    const raw = "<html><body>" + script + "<article>" + body + "</article></body></html>";
    expect(detectAppShell(raw, body)).toBe(false);
  });
});

describe("classifyContentKind", () => {
  it("flags app shells as markup-shell regardless of extractor", () => {
    expect(classifyContentKind("https://example.com/x", "defuddle", true)).toBe("markup-shell");
  });

  it("flags github tree pages as directory-listing", () => {
    expect(classifyContentKind("https://github.com/o/r/tree/main/src", "basic", false)).toBe(
      "directory-listing",
    );
  });

  it("flags raw.githubusercontent file URLs as code-file", () => {
    expect(
      classifyContentKind("https://raw.githubusercontent.com/o/r/main/x.ts", "raw", false),
    ).toBe("code-file");
  });

  it("flags github repo roots as repository-readme", () => {
    expect(classifyContentKind("https://github.com/o/r", "defuddle", false)).toBe(
      "repository-readme",
    );
    expect(classifyContentKind("https://github.com/o/r/", "defuddle", false)).toBe(
      "repository-readme",
    );
  });

  it("flags raw extractor output as raw-text", () => {
    expect(classifyContentKind("https://example.com/a.json", "raw", false)).toBe("raw-text");
  });

  it("flags defuddle extraction as article", () => {
    expect(classifyContentKind("https://example.com/article", "defuddle", false)).toBe("article");
  });

  it("falls back to unknown for unrecognized basic extraction", () => {
    expect(classifyContentKind("https://example.com/x", "basic", false)).toBe("unknown");
  });
});

describe("classifyConfidence", () => {
  it("flags shell-suspected pages as low", () => {
    expect(classifyConfidence("defuddle", true, 5000)).toBe("low");
  });

  it("flags raw extraction as high", () => {
    expect(classifyConfidence("raw", false, 0)).toBe("high");
  });

  it("flags substantial defuddle extraction as high", () => {
    expect(classifyConfidence("defuddle", false, 200)).toBe("high");
    expect(classifyConfidence("defuddle", false, 5000)).toBe("high");
  });

  it("flags sparse defuddle extraction as medium", () => {
    expect(classifyConfidence("defuddle", false, 50)).toBe("medium");
  });

  it("flags substantial basic extraction as medium", () => {
    expect(classifyConfidence("basic", false, 200)).toBe("medium");
  });

  it("flags sparse basic extraction as low", () => {
    expect(classifyConfidence("basic", false, 10)).toBe("low");
  });
});

describe("web_fetch honest-evidence details", () => {
  const fixture = createFetchHarness();
  let origin = "";
  let dependencies: Parameters<typeof executeWebFetch>[3];

  beforeAll(async () => {
    await fixture.start();
    origin = fixture.origin();
    dependencies = fixture.dependencies();
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it("reports requested and final URLs for a normal HTML page", async () => {
    const result = await executeWebFetch(
      { url: `${origin}/html` },
      undefined,
      undefined,
      dependencies,
    );
    expect(result.details.requestedUrl).toBe(`${origin}/html`);
    expect(result.details.finalUrl).toBe(`${origin}/html`);
    expect(result.details.contentKind).toBe("article");
    expect(result.details.shellSuspected).toBe(false);
    expect(result.details.confidence).toBe("medium");
  });

  it("classifies plain text as raw-text with high confidence", async () => {
    const result = await executeWebFetch(
      { url: `${origin}/continuation` },
      undefined,
      undefined,
      dependencies,
    );
    expect(result.details.contentKind).toBe("raw-text");
    expect(result.details.extractor).toBe("raw");
    expect(result.details.confidence).toBe("high");
  });

  it("rewrites github blob URLs and reports the canonical raw source", async () => {
    // A per-process unique URL keeps the test independent of the cross-session disk cache.
    const requested = `https://github.com/owner/repo/blob/main/file-${process.pid}.ts`;
    const expectedFinal = `https://raw.githubusercontent.com/owner/repo/main/file-${process.pid}.ts`;
    const validatedUrls: string[] = [];
    const fetchDependencies: FetchRemoteDependencies = {
      validateUrl: async (value) => {
        const url = value instanceof URL ? value : new URL(value);
        validatedUrls.push(url.toString());
        return { url, address: "127.0.0.1", family: 4, addresses: ["127.0.0.1"] };
      },
      request: async () => fakeTextResponse("export const example = 1;\n"),
    };
    const result = await executeWebFetch(
      { url: requested },
      undefined,
      undefined,
      fetchDependencies,
    );
    // The rewrite happens before validation, and the parallel llms.txt probe also
    // validates its own URL, so the rewritten raw URL must be among the validations.
    expect(validatedUrls).toContain(expectedFinal);
    expect(result.details.requestedUrl).toBe(requested);
    expect(result.details.finalUrl).toBe(expectedFinal);
    expect(result.details.contentKind).toBe("code-file");
    expect(result.details.confidence).toBe("high");
  });

  it("rewrites bare gist URLs to their raw path and reports the canonical source", async () => {
    const requested = `https://gist.github.com/owner/gist-id-${process.pid}`;
    const expectedFinal = `https://gist.github.com/owner/gist-id-${process.pid}/raw`;
    const validatedUrls: string[] = [];
    const fetchDependencies: FetchRemoteDependencies = {
      validateUrl: async (value) => {
        const url = value instanceof URL ? value : new URL(value);
        validatedUrls.push(url.toString());
        return { url, address: "127.0.0.1", family: 4, addresses: ["127.0.0.1"] };
      },
      request: async () => fakeTextResponse("const gist = true;\n"),
    };
    const result = await executeWebFetch(
      { url: requested },
      undefined,
      undefined,
      fetchDependencies,
    );
    // The rewrite happens before validation, and the parallel llms.txt probe also
    // validates its own URL, so the rewritten raw URL must be among the validations.
    expect(validatedUrls).toContain(expectedFinal);
    expect(result.details.requestedUrl).toBe(requested);
    expect(result.details.finalUrl).toBe(expectedFinal);
    expect(result.details.extractor).toBe("raw");
    expect(result.details.confidence).toBe("high");
  });
});
