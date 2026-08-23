import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vite-plus/test";
import { executeWebFetch, type FetchRemoteDependencies } from "../src/index";
import { parseLinkHeaderForAgentHints } from "../src/fetch";
import { buildLlmsTxtCandidateUrls } from "../src/service";

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

describe("buildLlmsTxtCandidateUrls", () => {
  it("maps any page path to the root index plus ancestor directory indexes", () => {
    expect(
      buildLlmsTxtCandidateUrls("https://example.com/a/b/c?x=1#frag").map((u) => u.href),
    ).toEqual(["https://example.com/llms.txt", "https://example.com/a/llms.txt"]);
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

  it("returns no hints for an empty header", () => {
    expect(parseLinkHeaderForAgentHints("", "https://example.com/")).toEqual({});
  });
});

describe("executeWebFetch llms.txt support", () => {
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
    expect(result.content[0]?.text).toContain("/llms.txt index instead");
    expect(result.content[0]?.text).not.toContain("also publishes");
    expect(result.content[0]?.text).toContain("# Example site");
  });

  it("advertises a usable /llms.txt alongside a healthy page", async () => {
    const { dependencies, requests } = recordingDependencies((href) => {
      if (href === "https://indexed.example.com/llms.txt") {
        return fakeResponse(200, "text/markdown", LLMS_TXT);
      }
      if (href.endsWith("/llms.txt")) return fakeResponse(404, "text/plain", "Not Found");
      return fakeResponse(200, "text/plain", "A perfectly readable plain-text page.\n".repeat(20));
    });
    const result = await executeWebFetch(
      { url: `https://indexed.example.com/page-${process.pid}` },
      undefined,
      undefined,
      dependencies,
    );
    expect(requests).toHaveLength(2);
    expect(result.details.llmsTxtFallback).toBe(false);
    expect(result.details.llmsTxtUrl).toBe("https://indexed.example.com/llms.txt");
    expect(result.content[0]?.text).toContain("https://indexed.example.com/llms.txt");
    expect(result.content[0]?.text).toContain("table of contents");
  });

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
    // Page + probes for root and /r2/; the deepest AVAILABLE index wins.
    expect(requests).toHaveLength(3);
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
    // Page + two probed candidates (root and /r2/); only /r2/ is usable.
    expect(requests).toHaveLength(3);
    expect(result.details.llmsTxtFallback).toBe(true);
    expect(result.details.finalUrl).toBe("https://r2shell.example.com/r2/llms.txt");
    expect(result.details.contentKind).toBe("llms-index");
  });

  it("stays silent when the site has no usable /llms.txt", async () => {
    const { dependencies, requests } = recordingDependencies((href) =>
      href.endsWith("/llms.txt")
        ? fakeResponse(404, "text/plain", "Not Found")
        : fakeResponse(200, "text/plain", "A perfectly readable plain-text page.\n".repeat(20)),
    );
    const result = await executeWebFetch(
      { url: `https://healthy.example.com/page-${process.pid}` },
      undefined,
      undefined,
      dependencies,
    );
    // The fresh origin still costs one probe request, cached negatively afterwards.
    expect(requests).toHaveLength(2);
    expect(result.details.llmsTxtFallback).toBe(false);
    expect(result.details.llmsTxtUrl).toBeUndefined();
    expect(result.content[0]?.text).not.toContain("also publishes");
  });

  it("keeps the primary page when the probed llms.txt is too short to be useful", async () => {
    const { dependencies, requests } = recordingDependencies((href) =>
      href.endsWith("/llms.txt")
        ? fakeResponse(200, "text/markdown", "# Stub\n")
        : fakeResponse(200, "text/html", APP_SHELL_HTML),
    );
    const result = await executeWebFetch(
      { url: `https://stub.example.com/page-${process.pid}` },
      undefined,
      undefined,
      dependencies,
    );
    expect(requests).toHaveLength(2);
    expect(result.details.llmsTxtFallback).toBe(false);
    expect(result.details.llmsTxtUrl).toBeUndefined();
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
    // Page + blind probes (root and /a/) + the advertised index.
    expect(requests).toHaveLength(4);
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

  it("serves an advertised Markdown version of a low-quality page", async () => {
    const markdownVersion = `https://altpage.example.com/page-${process.pid}.md`;
    const { dependencies, requests } = recordingDependencies((href) => {
      if (href === markdownVersion) return fakeResponse(200, "text/markdown", LLMS_TXT);
      if (href.endsWith("/llms.txt")) return fakeResponse(404, "text/plain", "Not Found");
      return fakeResponse(200, "text/html", APP_SHELL_HTML, {
        link: `</page-${process.pid}.md>; rel="alternate"; type="text/markdown"`,
      });
    });
    const requested = `https://altpage.example.com/page-${process.pid}`;
    const result = await executeWebFetch({ url: requested }, undefined, undefined, dependencies);
    // Page + root probe + the advertised .md version.
    expect(requests).toHaveLength(3);
    expect(result.details.markdownAlternateFallback).toBe(true);
    expect(result.details.llmsTxtFallback).toBe(false);
    expect(result.details.extractor).toBe("raw");
    expect(result.content[0]?.text).toContain("Markdown version advertised by the site");
    expect(result.content[0]?.text).toContain("# Example site");
  });

  it("keeps the primary page when an advertised Markdown version is unusable", async () => {
    const markdownVersion = `https://altstub.example.com/page-${process.pid}.md`;
    const { dependencies, requests } = recordingDependencies((href) => {
      if (href === markdownVersion) return fakeResponse(200, "text/markdown", "# Stub\n");
      if (href.endsWith("/llms.txt")) return fakeResponse(404, "text/plain", "Not Found");
      return fakeResponse(200, "text/html", APP_SHELL_HTML, {
        link: `</page-${process.pid}.md>; rel="alternate"; type="text/markdown"`,
      });
    });
    const result = await executeWebFetch(
      { url: `https://altstub.example.com/page-${process.pid}` },
      undefined,
      undefined,
      dependencies,
    );
    expect(requests).toHaveLength(3);
    expect(result.details.markdownAlternateFallback).toBe(false);
    expect(result.details.shellSuspected).toBe(true);
  });

  it("caches the per-origin probe across pages on the same origin", async () => {
    const { dependencies, requests } = recordingDependencies((href) =>
      href.endsWith("/llms.txt")
        ? fakeResponse(200, "text/markdown", LLMS_TXT)
        : fakeResponse(200, "text/plain", "Readable page body.\n".repeat(30)),
    );
    const first = await executeWebFetch(
      { url: `https://cached.example.com/page-a-${process.pid}` },
      undefined,
      undefined,
      dependencies,
    );
    const second = await executeWebFetch(
      { url: `https://cached.example.com/page-b-${process.pid}` },
      undefined,
      undefined,
      dependencies,
    );
    // Page A + one probe, then Page B reuses the cached probe result.
    expect(requests).toHaveLength(3);
    expect(first.details.llmsTxtUrl).toBe("https://cached.example.com/llms.txt");
    expect(second.details.llmsTxtUrl).toBe("https://cached.example.com/llms.txt");
  });
});
