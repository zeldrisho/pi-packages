import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vite-plus/test";
import { executeWebFetch, type FetchRemoteDependencies } from "../src/index";
import { parseLinkHeaderForAgentHints } from "../src/acquisition/fetch.ts";
import { buildLlmsTxtCandidateUrls } from "../src/service";
import { documentationMarkdownUrl } from "../src/acquisition/llms.ts";

/** Builds a minimal HTTP response for offline fetch testing. */
function fakeResponse(
  statusCode: number,
  contentType: string,
  body: string,
  extraHeaders: Record<string, string> = {},
): IncomingMessage {
  const buffer = Buffer.from(body);

  const iterator = {
    async *[Symbol.asyncIterator]() {
      yield buffer;
    },
  };

  // SAFETY: the literal satisfies IncomingMessage's stream contract; we set the few
  // fields the tests read (statusCode, headers) immediately above.
  return {
    statusCode,
    headers: { "content-type": contentType, ...extraHeaders },
    destroy() {},
    resume() {},
    ...iterator,
  } as IncomingMessage;
}

const APP_SHELL_HTML =
  "<!doctype html><html><head><title>Just a moment...</title></head>" +
  "<body>Please enable JavaScript to continue.</body></html>";

/** Long enough to clear the 200-character llms.txt usability floor. */
const LLMS_TXT = [
  "# Example site",
  "",
  "- [Docs](https://example.com/docs): the full documentation",
  "- [Guide](https://example.com/guide): getting started guide",
  "- [API](https://example.com/api): API reference",
  "",
]
  .join("\n")
  .repeat(8);

function recordingDependencies(respond: (href: string) => IncomingMessage) {
  const requests: string[] = [];

  const dependencies: FetchRemoteDependencies = {
    validateUrl: async (value) => {
      const url = value instanceof URL ? value : new URL(value);

      return { url, address: "127.0.0.1", family: 4, addresses: ["127.0.0.1"] };
    },
    request: async (target, _signal) => {
      const href = target.url.href;
      requests.push(href);

      return respond(href);
    },
  };

  return { dependencies, requests };
}

describe("documentation Markdown", () => {
  it("limits documented endpoints to known HTTPS documentation routes", () => {
    expect(documentationMarkdownUrl("https://nextjs.org/docs/app/x?tab=one#heading")?.href).toBe(
      "https://nextjs.org/docs/app/x.md?tab=one",
    );
    expect(documentationMarkdownUrl("https://vercel.com/docs/functions/")?.href).toBe(
      "https://vercel.com/docs/functions.md",
    );

    for (const url of [
      "https://nextjs.org/blog/x",
      "https://nextjs.org.evil/docs/x",
      "https://user@nextjs.org/docs/x",
      "https://nextjs.org/docs/x.md",
    ]) {
      expect(documentationMarkdownUrl(url)).toBeUndefined();
    }
  });

  it("refuses cross-origin redirects from documented Markdown endpoints", async () => {
    const html = `<html><body><main><p>${"Original documentation. ".repeat(30)}</p></main></body></html>`;

    const { dependencies, requests } = recordingDependencies((href) => {
      if (href === "https://vercel.com/docs/redirect-test") {
        return fakeResponse(200, "text/html", html);
      }

      if (href === "https://vercel.com/docs/redirect-test.md") {
        return fakeResponse(302, "text/plain", "", { location: "https://other.example/secret" });
      }

      return fakeResponse(404, "text/plain", "missing");
    });

    const result = await executeWebFetch(
      { url: "https://vercel.com/docs/redirect-test" },
      undefined,
      undefined,
      dependencies,
    );

    expect(requests).not.toContain("https://other.example/secret");
    expect(result.content[0]?.text).toContain("Original documentation");
  });

  it("prefers documented Markdown but keeps HTML when the endpoint fails", async () => {
    const html = `<html><body><main><h1>HTML page</h1><p>${"Useful documentation. ".repeat(30)}</p></main></body></html>`;

    for (const [path, succeeds] of [
      ["success", true],
      ["failure", false],
    ] as const) {
      const { dependencies, requests } = recordingDependencies((href) => {
        if (href.endsWith(`/docs/${path}`)) return fakeResponse(200, "text/html", html);

        if (href.endsWith(`/docs/${path}.md`) && succeeds) {
          return fakeResponse(
            200,
            "text/markdown",
            `# Markdown page\n${"Useful source content. ".repeat(20)}`,
          );
        }

        return fakeResponse(404, "text/plain", "missing");
      });

      const result = await executeWebFetch(
        { url: `https://nextjs.org/docs/${path}` },
        undefined,
        undefined,
        dependencies,
      );

      expect(requests).toContain(`https://nextjs.org/docs/${path}.md`);
      expect(result.content[0]?.text).toContain(
        succeeds ? "Markdown page" : "Useful documentation",
      );
    }
  });
});

describe("buildLlmsTxtCandidateUrls", () => {
  it("maps any page path to the root index plus ancestor directory indexes", () => {
    expect(
      buildLlmsTxtCandidateUrls(
        "https://example.com/en/docs/catalog/pay/api/rest-api?x=1#frag",
      ).map((u) => u.href),
    ).toEqual([
      "https://example.com/llms.txt",
      "https://example.com/en/llms.txt",
      "https://example.com/en/docs/llms.txt",
      "https://example.com/en/docs/catalog/llms.txt",
      "https://example.com/en/docs/catalog/pay/llms.txt",
      "https://example.com/en/docs/catalog/pay/api/llms.txt",
    ]);
    expect(buildLlmsTxtCandidateUrls("https://example.com").map((u) => u.href)).toEqual([
      "https://example.com/llms.txt",
    ]);
    expect(buildLlmsTxtCandidateUrls("http://example.com/a/b")[0].protocol).toBe("http:");
  });

  it("treats a trailing slash as a directory and never probes the page itself", () => {
    expect(buildLlmsTxtCandidateUrls("https://example.com/r2/").map((u) => u.pathname)).toEqual([
      "/llms.txt",
      "/r2/llms.txt",
    ]);
    expect(
      buildLlmsTxtCandidateUrls("https://example.com/docs/page").map((u) => u.pathname),
    ).toEqual(["/llms.txt", "/docs/llms.txt"]);
  });

  it("rejects non-HTTP(S), invalid, and self-referential targets", () => {
    expect(buildLlmsTxtCandidateUrls("ftp://example.com/file")).toEqual([]);
    expect(buildLlmsTxtCandidateUrls("not a url")).toEqual([]);
    expect(buildLlmsTxtCandidateUrls("https://example.com/llms.txt")).toEqual([]);
    expect(buildLlmsTxtCandidateUrls("https://example.com/docs/llms.txt")).toEqual([]);
  });
});

describe("parseLinkHeaderForAgentHints", () => {
  it("extracts describedby and markdown-alternate targets", () => {
    expect(
      parseLinkHeaderForAgentHints(
        '</docs/page.html.md>; rel="alternate"; type="text/markdown", </docs/llms.txt>; rel="describedby"',
        "https://example.com/docs/page",
      ),
    ).toEqual({
      describedBy: "https://example.com/docs/llms.txt",
      markdownAlternate: "https://example.com/docs/page.html.md",
    });
  });

  it("ignores unrelated relations and malformed directives", () => {
    expect(
      parseLinkHeaderForAgentHints(
        '</style.css>; rel="stylesheet", <https://example.com/y; rel=describedby, <https://example.com/x>; rel="alternate"; type="text/html"',
        "https://example.com/",
      ),
    ).toEqual({});
  });
});

describe("executeWebFetch llms.txt support", () => {
  it("does not advertise the index when the requested URL is already llms.txt", async () => {
    const { dependencies } = recordingDependencies(() =>
      fakeResponse(200, "text/markdown", LLMS_TXT),
    );

    const result = await executeWebFetch(
      { url: "https://direct.example.com/llms.txt" },
      undefined,
      undefined,
      dependencies,
    );

    expect(result.content[0]?.text).not.toContain("Caution:");
    expect(result.content[0]?.text).not.toContain("Index:");
    expect(result.content[0]?.text).not.toContain("<untrusted_web_content");
  });

  it("serves /llms.txt instead of an app-shell page", async () => {
    const { dependencies, requests } = recordingDependencies((href) => {
      if (href === "https://shell.example.com/llms.txt") {
        return fakeResponse(200, "text/markdown", LLMS_TXT);
      }

      if (href.endsWith("/llms.txt")) return fakeResponse(404, "text/plain", "Not Found");

      return fakeResponse(200, "text/html", APP_SHELL_HTML);
    });

    const requested = `https://shell.example.com/docs/page-${process.pid}`;
    const result = await executeWebFetch({ url: requested }, undefined, undefined, dependencies);
    // One request for the page plus one per probed candidate (root and /docs/).
    expect(requests).toHaveLength(3);
    expect(requests).toContain("https://shell.example.com/llms.txt");
    expect(result.details.llmsTxtFallback).toBe(true);
    expect(result.details.requestedUrl).toBe(requested);
    expect(result.details.finalUrl).toBe("https://shell.example.com/llms.txt");
    expect(result.details.contentKind).toBe("llms-index");
    expect(result.details.extractor).toBe("raw");
    expect(result.details.confidence).toBe("high");
    expect(result.content[0]?.text).toContain("Showing the site index instead");
    expect(result.content[0]?.text).not.toContain("also publishes");
    expect(result.content[0]?.text).toContain("# Example site");
  });

  it.each([
    {
      name: "authored no-JavaScript fallback",
      url: `https://fallback.example.com/report-${process.pid}`,
      html:
        "<!doctype html><html><head><title>Report</title></head><body>" +
        '<main class="wrap" id="main"></main>' +
        '<div class="status-pill hidden" id="status-pill">reconnecting&hellip;</div>' +
        '<noscript><div class="wrap prose"><h1>Quarterly report</h1><p>' +
        "Published report details remain readable without scripts. ".repeat(6) +
        "</p></div></noscript><script>// JavaScript is required for the interactive view.</script>" +
        "</body></html>",
      text: "Published report details remain readable",
      details: { noscriptFallback: true },
    },
    {
      name: "short intentional content",
      url: "https://short.example.com/production-error?code=31",
      html: "<!doctype html><html><body><main>Not found (code 31).</main></body></html>",
      text: "Not found (code 31).",
      details: {
        requestedUrl: "https://short.example.com/production-error?code=REDACTED",
        finalUrl: "https://short.example.com/production-error?code=REDACTED",
      },
    },
  ])("keeps $name instead of replacing it with /llms.txt", async ({ url, html, text, details }) => {
    const { dependencies, requests } = recordingDependencies((href) =>
      href.endsWith("/llms.txt")
        ? fakeResponse(200, "text/markdown", LLMS_TXT)
        : fakeResponse(200, "text/html", html),
    );

    const result = await executeWebFetch({ url }, undefined, undefined, dependencies);
    expect(requests).toContain(url);
    expect(result.details).toMatchObject({ llmsTxtFallback: false, ...details });
    expect(result.content[0]?.text).toContain(text);
    expect(result.content[0]?.text).not.toContain("Showing the site index instead");
    expect(result.content[0]?.text).not.toContain("# Example site");
  });

  it.each([
    ["usable", true],
    ["missing", false],
  ] as const)("caches a %s root index probe across healthy pages", async (name, usable) => {
    const origin = `https://${name}-root-index.example.com`;
    const index = `${origin}/llms.txt`;
    const page = "A perfectly readable plain-text page.";
    const { dependencies, requests } = recordingDependencies((href) => {
      if (href === index) {
        return usable
          ? fakeResponse(200, "text/markdown", LLMS_TXT)
          : fakeResponse(404, "text/plain", "Not Found");
      }

      return fakeResponse(200, "text/plain", `${page}\n`.repeat(20));
    });

    for (const [path, requestCount] of [
      ["first", 2],
      ["second", 3],
    ] as const) {
      const result = await executeWebFetch(
        { url: `${origin}/${path}-${process.pid}` },
        undefined,
        undefined,
        dependencies,
      );
      expect(requests).toHaveLength(requestCount);
      expect(result.details.llmsTxtFallback).toBe(false);
      expect(result.details.llmsTxtUrl).toBe(usable ? index : undefined);
      expect(result.content[0]?.text).toContain(page);

      if (usable) {
        expect(result.content[0]?.text).toContain(`Index: ${index}`);
      } else {
        expect(result.content[0]?.text).not.toContain("Index:");
        expect(result.content[0]?.text).not.toContain("also publishes");
      }
    }
  });

  it.each([
    ["equivalent alias", "root", LLMS_TXT, false],
    ["distinct alias", "root", `${LLMS_TXT}\nDistinct root index`, true],
    ["matching relative link", "relative", undefined, false],
    ["matching absolute link", "absolute", undefined, false],
    ["different origin", "external", undefined, true],
  ] as const)(
    "renders the section index notice for: %s",
    async (_, target, rootBody, showNotice) => {
      const origin = `https://index-notice-${target}-${showNotice}.example.com`;
      const root = `${origin}/llms.txt`;
      const section = `${origin}/docs/llms.txt`;
      const link = {
        root,
        relative: "[index](../llms.txt)",
        absolute: section,
        external: "[index](https://elsewhere.example/docs/llms.txt)",
      }[target];
      const bodyLink = `Documentation index: ${link}`;
      const { dependencies } = recordingDependencies((href) => {
        if (href === section) return fakeResponse(200, "text/markdown", LLMS_TXT);

        if (href === root && rootBody) return fakeResponse(200, "text/markdown", rootBody);

        if (href.endsWith("/llms.txt")) return fakeResponse(404, "text/plain", "Not Found");

        return fakeResponse(200, "text/plain", `${bodyLink}\n${"Page content. ".repeat(30)}`);
      });

      const result = await executeWebFetch(
        { url: `${origin}/docs/guides/page` },
        undefined,
        undefined,
        dependencies,
      );
      expect(result.details.llmsTxtUrl).toBe(section);
      expect(result.content[0]?.text).toContain(bodyLink);
      expect(result.content[0]?.text.includes(`Index: ${section}`)).toBe(showNotice);
    },
  );

  it("prefers a deeper section index over the site-wide one", async () => {
    const { dependencies, requests } = recordingDependencies((href) => {
      if (href.endsWith("/llms.txt")) {
        if (
          href === "https://sections.example.com/llms.txt" ||
          href === "https://sections.example.com/r2/llms.txt"
        ) {
          return fakeResponse(200, "text/markdown", LLMS_TXT);
        }

        return fakeResponse(404, "text/plain", "Not Found");
      }

      return fakeResponse(200, "text/plain", "Readable R2 documentation page.\n".repeat(20));
    });

    const result = await executeWebFetch(
      { url: `https://sections.example.com/r2/buckets/page-${process.pid}` },
      undefined,
      undefined,
      dependencies,
    );

    // Page + probes for root, /r2/, and /r2/buckets/; the deepest AVAILABLE index wins.
    expect(requests).toHaveLength(4);
    expect(requests).toContain("https://sections.example.com/r2/llms.txt");
    expect(result.details.llmsTxtUrl).toBe("https://sections.example.com/r2/llms.txt");
  });

  it("falls back to a section index when the site-wide one is missing", async () => {
    const { dependencies, requests } = recordingDependencies((href) => {
      if (href === "https://r2shell.example.com/r2/llms.txt") {
        return fakeResponse(200, "text/markdown", LLMS_TXT);
      }

      if (href.endsWith("/llms.txt")) return fakeResponse(404, "text/plain", "Not Found");

      return fakeResponse(200, "text/html", APP_SHELL_HTML);
    });

    const requested = `https://r2shell.example.com/r2/buckets/page-${process.pid}`;
    const result = await executeWebFetch({ url: requested }, undefined, undefined, dependencies);
    // Page + three probed candidates (root, /r2/, /r2/buckets/); only /r2/ is usable.
    expect(requests).toHaveLength(4);
    expect(result.details.llmsTxtFallback).toBe(true);
    expect(result.details.finalUrl).toBe("https://r2shell.example.com/r2/llms.txt");
    expect(result.details.contentKind).toBe("llms-index");
  });

  it("serves a usable site index when a bot challenge withholds the page", async () => {
    const { dependencies, requests } = recordingDependencies((href) => {
      if (href === "https://waf.example.com/en/docs/llms.txt") {
        return fakeResponse(200, "text/markdown", LLMS_TXT);
      }

      if (href.endsWith("/llms.txt")) return fakeResponse(404, "text/plain", "Not Found");

      return fakeResponse(202, "text/html; charset=UTF-8", "", {
        "x-amzn-waf-action": "challenge",
      });
    });

    const requested = `https://waf.example.com/en/docs/catalog/pay/api/rest-api-${process.pid}`;

    const result = await executeWebFetch({ url: requested }, undefined, undefined, {
      ...dependencies,
      solveAwsWafChallenges: false,
    });

    // Page plus the nearest ancestor batch; the section index is the deepest usable one.
    expect(requests).toHaveLength(5);
    expect(result.details.llmsTxtFallback).toBe(true);
    expect(result.details.requestedUrl).toBe(requested);
    expect(result.details.finalUrl).toBe("https://waf.example.com/en/docs/llms.txt");
    expect(result.details.contentKind).toBe("llms-index");
    expect(result.content[0]?.text).toContain("Showing the site index instead");
    expect(result.content[0]?.text).toContain("# Example site");
  });

  it("refetches a recovered page instead of serving a fresh cached index fallback", async () => {
    let blocked = true;

    const { dependencies, requests } = recordingDependencies((href) => {
      if (href.endsWith("/llms.txt")) return fakeResponse(200, "text/markdown", LLMS_TXT);

      if (blocked) return fakeResponse(202, "text/html", "", { "x-amzn-waf-action": "challenge" });

      return fakeResponse(200, "text/plain", "Recovered documentation page ".repeat(20));
    });

    const url = `https://recover-index.example.com/page-${process.pid}`;
    const noWafSolver = { ...dependencies, solveAwsWafChallenges: false };
    const first = await executeWebFetch({ url }, undefined, undefined, noWafSolver);
    expect(first.details.llmsTxtFallback).toBe(true);

    blocked = false;
    const second = await executeWebFetch({ url }, undefined, undefined, noWafSolver);
    expect(second.details.llmsTxtFallback).toBe(false);
    expect(second.content[0]?.text).toContain("Recovered documentation page");
    expect(requests.filter((href) => href === url)).toHaveLength(2);
  });

  it("reports the challenge when a withheld page has no usable index", async () => {
    const { dependencies } = recordingDependencies((href) =>
      href.endsWith("/llms.txt")
        ? fakeResponse(404, "text/plain", "Not Found")
        : fakeResponse(403, "text/html; charset=UTF-8", "", { "cf-mitigated": "challenge" }),
    );

    await expect(
      executeWebFetch(
        { url: `https://noindex.example.com/docs/page-${process.pid}` },
        undefined,
        undefined,
        dependencies,
      ),
    ).rejects.toThrow("web_fetch was blocked by Cloudflare's anti-bot challenge (HTTP 403).");
  });

  it("accepts Markdown documentation served as application/octet-stream", async () => {
    const body = [
      "# Wallet API",
      "",
      "## Deposit History (supporting network)",
      "",
      "GET /sapi/v1/capital/deposit/hisrec",
      "",
    ]
      .join("\n")
      .repeat(8);

    const { dependencies } = recordingDependencies((href) =>
      href.endsWith("/llms.txt")
        ? fakeResponse(404, "text/plain", "Not Found")
        : fakeResponse(200, "application/octet-stream", body),
    );

    const result = await executeWebFetch(
      { url: `https://octet.example.com/en/docs/wallet/Introduction.md` },
      undefined,
      undefined,
      dependencies,
    );

    expect(result.details.contentType).toBe("application/octet-stream");
    expect(result.details.extractor).toBe("raw");
    expect(result.content[0]?.text).toContain("Deposit History (supporting network)");
  });

  it("still rejects generic binary responses whose path is not a text document", async () => {
    const { dependencies } = recordingDependencies((href) =>
      href.endsWith("/llms.txt")
        ? fakeResponse(404, "text/plain", "Not Found")
        : fakeResponse(200, "application/octet-stream", "\u0000\u0001binary"),
    );

    await expect(
      executeWebFetch(
        { url: `https://octet.example.com/archive-${process.pid}.bin` },
        undefined,
        undefined,
        dependencies,
      ),
    ).rejects.toThrow("does not support application/octet-stream");
  });

  it("uses an advertised describedby index deeper than blind candidates reach", async () => {
    const advertisedIndex = "https://advertised.example.com/deep/section/llms.txt";

    const { dependencies, requests } = recordingDependencies((href) => {
      if (href === advertisedIndex) return fakeResponse(200, "text/markdown", LLMS_TXT);

      if (href.endsWith("/llms.txt")) return fakeResponse(404, "text/plain", "Not Found");

      return fakeResponse(200, "text/html", APP_SHELL_HTML, {
        link: `</deep/section/llms.txt>; rel="describedby"`,
      });
    });

    const requested = `https://advertised.example.com/a/b/page-${process.pid}`;
    const result = await executeWebFetch({ url: requested }, undefined, undefined, dependencies);
    // Page + blind probes (root, /a/, /a/b/) + the advertised index.
    expect(requests).toHaveLength(5);
    expect(result.details.llmsTxtFallback).toBe(true);
    expect(result.details.finalUrl).toBe(advertisedIndex);
    expect(result.details.contentKind).toBe("llms-index");
  });

  it("discovers a describedby index from HTML link elements too", async () => {
    const shellWithLinks =
      "<!doctype html><html><head>" +
      '<link rel="describedby" href="/site/llms.txt">' +
      "<title>Just a moment...</title></head>" +
      "<body>Please enable JavaScript to continue.</body></html>";

    const { dependencies } = recordingDependencies((href) => {
      if (href === "https://htmllink.example.com/site/llms.txt") {
        return fakeResponse(200, "text/markdown", LLMS_TXT);
      }

      if (href.endsWith("/llms.txt")) return fakeResponse(404, "text/plain", "Not Found");

      return fakeResponse(200, "text/html", shellWithLinks);
    });

    const result = await executeWebFetch(
      { url: `https://htmllink.example.com/page-${process.pid}` },
      undefined,
      undefined,
      dependencies,
    );

    expect(result.details.llmsTxtFallback).toBe(true);
    expect(result.details.finalUrl).toBe("https://htmllink.example.com/site/llms.txt");
  });

  it.each(["low-quality", "empty"] as const)(
    "serves advertised Markdown when the HTML extraction is %s",
    async (quality) => {
      const path = `/page-${process.pid}`;
      const requested = `https://${quality}-alternate.example.com${path}`;
      const { dependencies, requests } = recordingDependencies((href) => {
        if (href === `${requested}.md`) return fakeResponse(200, "text/markdown", LLMS_TXT);

        if (href.endsWith("/llms.txt")) return fakeResponse(404, "text/plain", "Not Found");

        return quality === "low-quality"
          ? fakeResponse(200, "text/html", APP_SHELL_HTML, {
              link: `<${path}.md>; rel="alternate"; type="text/markdown"`,
            })
          : fakeResponse(
              200,
              "text/html",
              `<html><head><link rel="alternate" type="text/markdown" href="${path}.md"></head><body></body></html>`,
            );
      });

      const result = await executeWebFetch({ url: requested }, undefined, undefined, dependencies);
      // Page + root probe + the advertised .md version.
      expect(requests).toHaveLength(3);
      expect(result.details).toMatchObject({
        markdownAlternateFallback: true,
        llmsTxtFallback: false,
        extractor: "raw",
      });
      expect(result.content[0]?.text).toContain("site's advertised Markdown version");
      expect(result.content[0]?.text).toContain("# Example site");
    },
  );

  it("preserves the empty-content error when no fallback is available", async () => {
    const { dependencies } = recordingDependencies((href) =>
      href.endsWith("/llms.txt")
        ? fakeResponse(404, "text/plain", "Not Found")
        : fakeResponse(200, "text/html", "<html><head></head><body></body></html>"),
    );

    await expect(
      executeWebFetch(
        { url: `https://emptyprimary.example.com/page-${process.pid}` },
        undefined,
        undefined,
        dependencies,
      ),
    ).rejects.toThrow("web_fetch: Page has no extractable content.");
  });

  it.each([
    ["probed llms.txt", false, 2],
    ["advertised Markdown", true, 3],
  ] as const)(
    "keeps the primary page when %s is too short",
    async (_, advertised, requestCount) => {
      const path = `/page-${process.pid}`;
      const url = `https://${advertised ? "alternate" : "index"}-stub.example.com${path}`;
      const { dependencies, requests } = recordingDependencies((href) => {
        if (href === `${url}.md` || (!advertised && href.endsWith("/llms.txt"))) {
          return fakeResponse(200, "text/markdown", "# Stub\n");
        }

        if (href.endsWith("/llms.txt")) return fakeResponse(404, "text/plain", "Not Found");

        return fakeResponse(
          200,
          "text/html",
          APP_SHELL_HTML,
          advertised ? { link: `<${path}.md>; rel="alternate"; type="text/markdown"` } : {},
        );
      });

      const result = await executeWebFetch({ url }, undefined, undefined, dependencies);
      expect(requests).toHaveLength(requestCount);
      expect(result.details.llmsTxtFallback).toBe(false);
      expect(result.details.llmsTxtUrl).toBeUndefined();
      expect(result.details.markdownAlternateFallback).toBe(false);
      expect(result.details.shellSuspected).toBe(true);
    },
  );

  it("reports uncached Anubis challenges consistently across output views", async () => {
    const views = [
      { name: "plain", offset: undefined, query: undefined, fragment: "" },
      { name: "continuation", offset: 100, query: undefined, fragment: "" },
      { name: "focus", offset: undefined, query: "Anubis", fragment: "" },
      { name: "fragment", offset: undefined, query: undefined, fragment: "#verification" },
    ];

    for (const { name, offset, query, fragment } of views) {
      const { dependencies, requests } = recordingDependencies((href) =>
        href.endsWith("/llms.txt")
          ? fakeResponse(404, "text/plain", "Not Found")
          : fakeResponse(
              200,
              "text/html",
              '<html><head><title>Anubis</title></head><body>The administrator of this website has set <a href="/setup">up</a> Anubis to protect the server against scrapers. Anubis uses a Proof-of-Work scheme in the vein of Hashcash. Please note that Anubis requires the use of modern JavaScript features.<h2 id="verification">Verification</h2><a href="/help">Help</a></body></html>',
            ),
      );

      const url = `https://anubis-${process.pid}.example.com/packaging-guidelines-${name}`;
      const params = { url: `${url}${fragment}`, offset, query };

      const first = await executeWebFetch(params, undefined, undefined, dependencies);
      const second = await executeWebFetch(params, undefined, undefined, dependencies);

      expect
        .soft(first.content[0]?.text, name)
        .toBe("Blocked by an anti-bot challenge. Requested page content is unavailable.");
      expect.soft(first.details, name).toMatchObject({
        extractionDiagnostics: { botWall: true },
        truncated: false,
        totalCharacters: 0,
        characterCount: 0,
        offset: 0,
        outline: { headings: [] },
      });

      for (const field of ["title", "nextOffset", "focus", "links"] as const) {
        expect.soft(first.details[field], `${name}: ${field}`).toBeUndefined();
      }

      expect.soft(second.details.cacheStatus, name).toBe("miss");
      expect
        .soft(
          requests.filter((request) => request === url),
          name,
        )
        .toHaveLength(2);
    }
  });
});
