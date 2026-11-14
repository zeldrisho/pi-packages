import type { IncomingMessage } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { executeWebFetch, type FetchRemoteDependencies } from "../src/index";
import { classifyContentKind, classifyConfidence } from "../src/service";
import { detectAppShell, normalizeGitHubRawUrl } from "../src/acquisition/fetch.ts";
import { createFetchHarness } from "./harness";

/** Builds a minimal HTTP response for offline fetch testing. */
function fakeTextResponse(body: string, contentType = "text/plain"): IncomingMessage {
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
    headers: { "content-type": contentType },
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
    expect(result.details.outline).toMatchObject({
      totalHeadings: 1,
      headings: [{ level: 2, text: "Hello", inferred: false }],
      omittedHeadings: 0,
    });
  });

  it("retrieves Packit Copr jobs from their public API", async () => {
    const requested: string[] = [];

    const dependencies: FetchRemoteDependencies = {
      validateUrl: async (value) => {
        const url = value instanceof URL ? value : new URL(value);

        return { url, address: "127.0.0.1", family: 4, addresses: ["127.0.0.1"] };
      },
      request: async (target) => {
        requested.push(target.url.href);

        return fakeTextResponse('{"status":"success"}', "application/json");
      },
    };

    const result = await executeWebFetch(
      { url: "https://dashboard.packit.dev/jobs/copr/4228191" },
      undefined,
      undefined,
      dependencies,
    );

    expect(requested).toEqual(["https://prod.packit.dev/api/copr-builds/4228191"]);
    expect(result.content[0].text).not.toContain("Showing Packit");
    expect(result.details).toMatchObject({
      requestedUrl: "https://dashboard.packit.dev/jobs/copr/4228191",
      finalUrl: requested[0],
      representationFallback: "packit-api",
    });
    expect(result.structuredContent).toMatchObject({
      finalUrl: requested[0],
      representationFallback: "packit-api",
      markdown: expect.stringContaining("success"),
    });
  });

  it("retrieves an empty Swagger UI's advertised same-origin specification", async () => {
    const dependencies: FetchRemoteDependencies = {
      validateUrl: async (value) => {
        const url = value instanceof URL ? value : new URL(value);

        return { url, address: "127.0.0.1", family: 4, addresses: ["127.0.0.1"] };
      },
      request: async (target) => {
        if (target.url.pathname === "/api/swagger.json")
          return fakeTextResponse('{"swagger":"2.0","info":{},"paths":{}}', "application/json");

        if (target.url.pathname === "/api/")
          return fakeTextResponse(
            '<html><body><div id="swagger-ui"></div><script>new SwaggerUIBundle({url: "/api/swagger.json"})</script></body></html>',
            "text/html",
          );

        return fakeTextResponse("");
      },
    };

    const result = await executeWebFetch(
      { url: "https://swagger-test.example/api/" },
      undefined,
      undefined,
      dependencies,
    );

    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("advertised Swagger specification"),
    });
    expect(result.structuredContent).toMatchObject({
      finalUrl: "https://swagger-test.example/api/swagger.json",
      representationFallback: "swagger-spec",
      contentKind: "openapi-spec",
    });
  });

  it("does not fetch a cross-origin Swagger advertisement", async () => {
    const requested: string[] = [];

    const dependencies: FetchRemoteDependencies = {
      validateUrl: async (value) => {
        const url = value instanceof URL ? value : new URL(value);

        return { url, address: "127.0.0.1", family: 4, addresses: ["127.0.0.1"] };
      },
      request: async (target) => {
        requested.push(target.url.href);

        return fakeTextResponse(
          target.url.pathname === "/api/"
            ? '<html><body><div id="swagger-ui"></div><script>new SwaggerUIBundle({url: "https://other.example/spec.json"})</script></body></html>'
            : "",
          "text/html",
        );
      },
    };

    await expect(
      executeWebFetch(
        { url: "https://swagger-cross.example/api/" },
        undefined,
        undefined,
        dependencies,
      ),
    ).rejects.toThrow("no extractable content");
    expect(requested.every((url) => new URL(url).hostname === "swagger-cross.example")).toBe(true);
  });

  it("reports an empty JavaScript app shell in text and structured output", async () => {
    const dependencies: FetchRemoteDependencies = {
      validateUrl: async (value) => {
        const url = value instanceof URL ? value : new URL(value);

        return { url, address: "127.0.0.1", family: 4, addresses: ["127.0.0.1"] };
      },
      request: async (target) =>
        fakeTextResponse(
          target.url.pathname === "/shell"
            ? '<html><head><title>Packit Service</title><script type="module" src="/assets/app.js"></script></head><body><noscript>You need to enable JavaScript to run this app.</noscript><div id="root"></div></body></html>'
            : "",
          "text/html",
        ),
    };

    const result = await executeWebFetch(
      { url: "https://shell-test.example/shell" },
      undefined,
      undefined,
      dependencies,
    );

    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("requires JavaScript; its content could not be retrieved"),
    });
    expect(result.structuredContent).toMatchObject({
      markdown: "",
      blocked: false,
      extraction: { javascriptRequired: true },
    });
    expect(result.details.shellSuspected).toBe(true);
  });

  it.each([
    [
      "readme",
      "<article class='markdown-body entry-content' itemprop='text'><h1>Short README</h1><p>Useful content.</p></article>",
      false,
      "repository-readme",
    ],
    ["missing", "<p>Short page without a README.</p>", true, "markup-shell"],
    [
      "challenge",
      "<article class='markdown-body entry-content' itemprop='text'><h1>Short README</h1><p>Useful content.</p></article><p>Please enable JavaScript</p>",
      true,
      "markup-shell",
    ],
  ])(
    "reports extraction evidence for a %s GitHub repository page",
    async (name, content, warning, kind) => {
      const fetchDependencies: FetchRemoteDependencies = {
        validateUrl: async (value) => {
          const url = value instanceof URL ? value : new URL(value);

          return { url, address: "127.0.0.1", family: 4, addresses: ["127.0.0.1"] };
        },
        request: async () =>
          fakeTextResponse(
            `<html><body><main>${content}</main><script>${"x".repeat(20_000)}</script></body></html>`,
            "text/html",
          ),
      };

      const result = await executeWebFetch(
        { url: `https://github.com/test-owner/${name}-${process.pid}` },
        undefined,
        undefined,
        fetchDependencies,
      );

      expect(result.details.shellSuspected).toBe(warning);
      expect(result.details.contentKind).toBe(kind);
      expect(result.details.extractionDiagnostics?.sparseExtraction).toBe(name === "missing");

      if (name === "readme") expect(result.details.confidence).not.toBe("low");

      if (name === "challenge")
        expect(result.details.extractionDiagnostics?.javascriptRequired).toBe(true);
    },
  );

  it("redacts credential-bearing query values from progress and result evidence", async () => {
    const requested = `https://credentials.example.com/page-${process.pid}?token=secret-token&page=2`;
    const redacted = `https://credentials.example.com/page-${process.pid}?token=REDACTED&page=2`;
    const updates: string[] = [];
    const transportedUrls: string[] = [];

    const fetchDependencies: FetchRemoteDependencies = {
      validateUrl: async (value) => {
        const url = value instanceof URL ? value : new URL(value);

        return { url, address: "127.0.0.1", family: 4, addresses: ["127.0.0.1"] };
      },
      request: async (target) => {
        transportedUrls.push(target.url.href);

        return fakeTextResponse("credential-safe content");
      },
    };

    const result = await executeWebFetch(
      { url: requested },
      undefined,
      (update) => updates.push(update.content[0]?.text ?? ""),
      fetchDependencies,
    );

    expect(transportedUrls[0]).toBe(requested);
    expect(updates).toEqual([`Fetching ${redacted}…`]);
    expect(result.details.url).toBe(redacted);
    expect(result.details.requestedUrl).toBe(redacted);
    expect(result.details.finalUrl).toBe(redacted);
    expect(result.content[0]?.text).not.toContain("Caution:");
    expect(result.content[0]?.text).not.toContain("secret-token");
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it("redacts credential-bearing query values from extracted link details", async () => {
    const requested = `https://links.example.com/page-${process.pid}`;

    const fetchDependencies: FetchRemoteDependencies = {
      validateUrl: async (value) => {
        const url = value instanceof URL ? value : new URL(value);

        return { url, address: "127.0.0.1", family: 4, addresses: ["127.0.0.1"] };
      },
      request: async () =>
        fakeTextResponse(
          '<a href="/internal?token=internal-secret">Internal</a><a href="https://external.example.com/page?client_secret=external-secret">External</a>',
          "text/html",
        ),
    };

    const result = await executeWebFetch(
      { url: requested },
      undefined,
      undefined,
      fetchDependencies,
    );

    expect(result.details.links?.internal[0]?.url).toBe(
      "https://links.example.com/internal?token=REDACTED",
    );
    expect(result.details.links?.external[0]?.url).toBe(
      "https://external.example.com/page?client_secret=REDACTED",
    );
    expect(JSON.stringify(result.details.links)).not.toContain("internal-secret");
    expect(JSON.stringify(result.details.links)).not.toContain("external-secret");
  });

  it("classifies standalone and embedded OpenAPI specs", async () => {
    const spec = await executeWebFetch(
      { url: `${origin}/openapi-json` },
      undefined,
      undefined,
      dependencies,
    );

    const bundle = await executeWebFetch(
      { url: `${origin}/minified-js` },
      undefined,
      undefined,
      dependencies,
    );

    expect(spec.details.contentKind).toBe("openapi-spec");
    expect(bundle.details.contentKind).toBe("openapi-spec");
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

  it("reports the standard block for a JavaScript CAPTCHA interstitial", async () => {
    fixture.resetCaptchaChallengeRequests();
    const url = `${origin}/captcha-challenge`;

    const first = await executeWebFetch({ url }, undefined, undefined, dependencies);
    const second = await executeWebFetch({ url }, undefined, undefined, dependencies);

    expect(first.content[0].text).toContain("Blocked by an anti-bot challenge.");
    expect(first.details.extractionDiagnostics?.botWall).toBe(true);
    expect(second.content[0].text).toContain("Blocked by an anti-bot challenge.");
    // Blocked challenge results are never cached, so the second call refetches.
    expect(fixture.captchaChallengeRequests()).toBe(2);
  });
});
