import { parseHTML } from "linkedom";
import type { DefuddleResponse } from "defuddle/node";
import { stripExtractedCssCruft } from "./markdown-cleanup.ts";
import { buildFragmentOffsets } from "./fragment-index.ts";
import { assertConversionDepth } from "./complexity.ts";
import { hasJavaScriptMarkers, isSparseExtraction } from "./evidence.ts";

export { stripExtractedCssCruft } from "./markdown-cleanup.ts";

const RAW_ID_SELECTOR_SAFE = /^-?[_a-zA-Z][-_a-zA-Z0-9]*$/;

/** Minimum authored no-JavaScript fallback length worth showing instead of a shell. */
const NOSCRIPT_FALLBACK_MIN_CHARACTERS = 200;

/** Primary extraction length below which a JavaScript-required page counts as a shell. */
const NOSCRIPT_PRIMARY_MAX_CHARACTERS = 1024;

/** Removes schema.org scripts that Defuddle would report directly to the process console. */
function removeMalformedSchemaOrgData(document: Document): void {
  for (const script of document.querySelectorAll<HTMLScriptElement>(
    'script[type="application/ld+json"]',
  )) {
    const jsonContent = (script.textContent || "")
      .replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "")
      .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1")
      .replace(/^\s*(\*\/|\/\*)\s*|\s*(\*\/|\/\*)\s*$/g, "")
      .trim();

    try {
      if (JSON.parse(jsonContent) === null) script.remove();
    } catch {
      script.remove();
    }
  }
}

/**
 * Replaces element IDs that are unsafe for CSS selectors and updates matching fragment links.
 *
 * @param document - The document whose element IDs and same-document links are normalized
 */
function normalizeSelectorUnsafeIds(document: Document): void {
  const replacements = new Map<string, string>();

  const occupiedIds = new Set(
    [...document.querySelectorAll<HTMLElement>("[id]")].map((element) => element.id),
  );

  let replacementIndex = 0;

  for (const element of document.querySelectorAll<HTMLElement>("[id]")) {
    const id = element.id;

    if (!id || RAW_ID_SELECTOR_SAFE.test(id)) continue;

    let replacement: string;

    do {
      replacement = `defuddle-safe-id-${replacementIndex++}`;
    } while (occupiedIds.has(replacement));

    occupiedIds.add(replacement);

    if (!replacements.has(id)) replacements.set(id, replacement);
    element.id = replacement;
  }

  if (replacements.size === 0) return;

  for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')) {
    const href = anchor.getAttribute("href");

    if (!href) continue;
    const replacement = replacements.get(href.slice(1));

    if (replacement) anchor.setAttribute("href", `#${replacement}`);
  }
}

/** Head-level elements that carry metadata rather than readable body content. */
const HEAD_TAGS = new Set(["TITLE", "BASE", "LINK", "META", "STYLE"]);

function isElementNode(node: ChildNode): node is Element {
  return node.nodeType === 1;
}

/**
 * linkedom parses HTML that omits `<html>`/`<head>`/`<body>` as a fragment: the first
 * element becomes the document root and `document.body` is left detached and empty.
 * HTML5 permits those omissions, but body-based extraction (Defuddle and the plain-text
 * fallback) then sees nothing. Rebuild a well-formed `<html>` document, moving the
 * fragment's top-level nodes into `<head>` or `<body>` as appropriate.
 * Empty and text-only documents also receive these wrappers, with text moved
 * into the body. Documents already rooted at `<html>` are left unchanged.
 */
function normalizeFragmentDocument(document: Document): void {
  const root = document.documentElement;

  if (root?.tagName === "HTML") return;

  const html = document.createElement("html");
  const head = document.createElement("head");
  const body = document.createElement("body");
  html.appendChild(head);
  html.appendChild(body);

  const nodes = root
    ? root.tagName === "BODY"
      ? [...root.childNodes]
      : [...document.childNodes]
    : [...document.childNodes];

  for (const node of nodes) {
    if (node.nodeType === 3) {
      body.appendChild(node);
      continue;
    }

    if (!isElementNode(node)) continue;
    const tagName = node.tagName;

    if (tagName === "HTML") continue;

    if (tagName === "HEAD" || tagName === "BODY") {
      const destination = tagName === "HEAD" ? head : body;

      while (node.firstChild) destination.appendChild(node.firstChild);

      node.remove();
      continue;
    }

    (HEAD_TAGS.has(tagName) ? head : body).appendChild(node);
  }

  document.insertBefore(html, document.firstChild);
}

/** Removes explicitly hidden body elements before either extractor can promote them to content. */
function removeHiddenBodyElements(document: Document): void {
  for (const element of document.body.querySelectorAll("[hidden], [aria-hidden], [style]")) {
    const style = element.getAttribute("style") ?? "";

    const hiddenStyle =
      /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important\s*)?(?:;|$)/i.test(
        style,
      );

    if (
      element.hasAttribute("hidden") ||
      element.getAttribute("aria-hidden")?.trim().toLowerCase() === "true" ||
      hiddenStyle
    ) {
      element.remove();
    }
  }
}

/** Detects an explicitly marked but empty main region with a script in place of content. */
function hasEmptyScriptedMain(document: Document): boolean {
  const regions = document.body.querySelectorAll('main, [role="main"]');

  if (regions.length !== 1) return false;

  const main = regions[0];

  if (
    !main.querySelector("script") ||
    main.querySelector("img, svg, video, audio, canvas, iframe, object, embed, form")
  )
    return false;

  const copy = document.createElement("div");
  copy.appendChild(main.cloneNode(true));

  for (const element of copy.querySelectorAll("script, style, template, noscript")) {
    element.remove();
  }

  return !(copy.textContent ?? "").trim();
}

/**
 * Extracts normalized plain text from HTML when structured Markdown extraction is unavailable.
 *
 * @param html - The HTML content to convert
 * @returns The trimmed text content with excluded elements and excessive whitespace removed
 * @throws When markup exceeds the safe conversion depth; DOM parsing errors propagate
 */
export function htmlToMarkdownFallback(html: string): string {
  assertConversionDepth(html);
  const { document } = parseHTML(html);
  normalizeFragmentDocument(document);

  for (const element of document.querySelectorAll(
    "script, style, svg, noscript, template, iframe, nav, header, footer, aside, form",
  )) {
    element.remove();
  }

  removeHiddenBodyElements(document);

  for (const element of document.body.querySelectorAll(
    "p, div, section, article, li, blockquote, pre, h1, h2, h3, h4, h5, h6, br, tr",
  )) {
    element.after(document.createTextNode("\n\n"));
  }

  return document.body.textContent
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Asserts that a URL is absolute http(s) and returns it, or throws for bare pathnames. */
export function assertAbsoluteHttpUrl(value: string | URL): URL {
  const url = value instanceof URL ? value : new URL(value);

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(`Expected absolute http(s) URL, got ${url.protocol}: ${url.href}`);
  }

  return url;
}

/** Resolves page-URL metadata that Defuddle otherwise parses without a base URL. */
function resolveDocumentRelativeMetadataUrls(document: Document, pageUrl: URL): void {
  for (const meta of document.querySelectorAll<HTMLMetaElement>("meta[content]")) {
    const key = (meta.getAttribute("property") ?? meta.getAttribute("name"))?.toLowerCase();

    if (key !== "og:url" && key !== "twitter:url") continue;
    const content = meta.getAttribute("content");

    if (!content) continue;

    try {
      meta.setAttribute("content", new URL(content, pageUrl).href);
    } catch {
      meta.removeAttribute("content");
    }
  }

  for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="canonical"][href]')) {
    const href = link.getAttribute("href");

    if (!href) continue;

    try {
      link.setAttribute("href", new URL(href, pageUrl).href);
    } catch {
      link.removeAttribute("href");
    }
  }
}

/**
 * Type guard that checks if an unknown value is a string.
 *
 * @param value - The value to check
 * @returns `true` if the value is a string
 */
function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** Returns true when a rejection looks like `ERR_INVALID_URL` for a bare pathname. */
function isBarePathnameInvalidUrl(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;

  if (!/Invalid URL/i.test(cause.message)) return false;
  // SAFETY: Node's ERR_INVALID_URL extends Error with an `input` string property holding the offending URL.
  const input = (cause as NodeJS.ErrnoException & { input?: unknown }).input;

  if (isString(input) && input.startsWith("/")) return true;
  const detail = `${cause.message}\n${cause.stack ?? ""}`;

  // Node's ERR_INVALID_URL prints `input: '/path'` in the message/stack even when
  // `input` is not on the error instance in some Node versions.
  return /input:\s*'\/[^']*'/.test(detail);
}

/**
 * Removes chrome wrappers that pollute Defuddle's article extraction on GitHub releases.
 *
 * @param document - The document from which to remove chrome wrappers
 * @param baseUrl - The absolute URL of the page, used to determine if chrome should be stripped
 */
function stripChromeWrappers(document: Document, baseUrl: URL): void {
  // Only strip chrome wrappers for GitHub release pages
  const isGitHubRelease =
    baseUrl.hostname === "github.com" && /\/releases(?:\/|$)/.test(baseUrl.pathname);

  if (!isGitHubRelease) return;

  for (const element of document.querySelectorAll("nav, header, footer, aside")) {
    element.remove();
  }
}

/** Restricts GitHub repository roots to their rendered README, when available. */
function isolateGitHubReadme(document: Document, baseUrl: URL): boolean {
  if (baseUrl.hostname !== "github.com" || baseUrl.pathname.split("/").filter(Boolean).length !== 2)
    return false;

  let readme = document.querySelector("main article.markdown-body.entry-content[itemprop='text']");

  if (!readme) {
    // GitHub renders plain-text READMEs outside the markdown article. Require
    // the active README tab immediately beside the plain content, not just a pre.
    for (const nav of document.querySelectorAll('main nav[aria-label="Repository files"]')) {
      const activeTab = nav.querySelector('a[aria-current="page"] [data-content="README"]');
      const content = nav.parentElement?.nextElementSibling;
      const plain = content?.querySelector("div.plain > pre");

      if (activeTab && plain?.textContent?.trim()) {
        readme = plain;
        break;
      }
    }
  }

  if (!readme || !readme.textContent?.trim()) return false;

  const main = document.createElement("main");
  main.appendChild(readme);
  document.body.replaceChildren(main);

  return true;
}

/**
 * Collapses consecutive duplicate markdown link lines (e.g. duplicated [Latest] on GitHub releases).
 *
 * @param markdown - The markdown string to process
 * @returns The markdown with adjacent duplicate links removed
 */
function deduplicateAdjacentLinks(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let previousTrimmed: string | undefined;

  for (const line of lines) {
    const trimmed = line.trim();

    const isLinkLine =
      /^\[[^\]]+\]\(<[^>]+>\)$/.test(trimmed) || /^\[[^\]]+\]\([^)]+\)$/.test(trimmed);

    if (isLinkLine && trimmed === previousTrimmed) continue;
    out.push(line);
    previousTrimmed = isLinkLine ? trimmed : undefined;
  }

  // Also collapse duplicate adjacent blocks like a repeated vite-plus tag link paragraph.
  return out.join("\n").replace(/(\[[^\n]+?\([^)]+\)[^\n]*\n)\1/g, "$1");
}

/**
 * Runs Defuddle over an already-normalized document with Markdown extraction enabled.
 *
 * Defuddle can fail in two distinct ways. The common case rejects the promise
 * we `await` below, which the caller's `try/catch` catches and turns into a
 * fallback. The dangerous case is when Defuddle schedules a throw on a
 * *detached* microtask or timer — for example, when it resolves a
 * document-relative link such as `/owner/repo/releases` into
 * `new URL(relative, undefined)` *after* its own promise has already resolved.
 * That rejection never reaches the `await` and instead escapes as an unhandled
 * rejection that bypasses the surrounding `try/catch` and crashes the calling
 * harness UI. Passing the absolute `pageUrl` prevents the URL-resolution form
 * of this failure, but the guard below still covers any residual detached
 * rejection.
 *
 * To keep `extractHtmlToMarkdown` from ever propagating such a failure, this
 * helper arms a scoped `unhandledRejection` listener for the lifetime of the
 * call. The listener is scoped, not process-wide in effect: it only treats a
 * rejection as a Defuddle failure when its message or stack mentions Defuddle
 * or looks like a bare-pathname `ERR_INVALID_URL` occurring within the armed
 * window, so unrelated rejections from other concurrent work are ignored and do
 * not force a spurious fallback to the basic extractor. After Defuddle resolves we
 * flush a microtask and a macrotask so any rejection Defuddle scheduled settles
 * inside the armed window; a rejection observed there is re-thrown so the
 * caller falls back. Deeply-nested timers in Defuddle are out of scope and would
 * still surface as a logged (non-crashing) unhandled rejection.
 *
 * @param document - The normalized document to parse
 * @param pageUrl - The absolute URL of the page, used to resolve relative links
 * @returns The Defuddle result, or `undefined` when extraction must fall back
 */
async function runDefuddle(
  document: Document,
  pageUrl: string,
): Promise<DefuddleResponse | undefined> {
  let escapedRejection: unknown = undefined;
  let armed = true;

  const captureUnhandled = (cause: unknown): void => {
    if (!armed || escapedRejection !== undefined) return;

    const detail =
      cause instanceof Error ? `${cause.message}\n${cause.stack ?? ""}` : String(cause);

    if (/defuddle/i.test(detail) || isBarePathnameInvalidUrl(cause)) escapedRejection = cause;
  };

  process.on("unhandledRejection", captureUnhandled);

  try {
    const { Defuddle } = await import("defuddle/node");

    const result = await Defuddle(document, pageUrl, {
      markdown: true,
      useAsync: false,
      removeImages: true,
    });

    // Let Defuddle's scheduled microtask/macrotask work settle so a detached
    // rejection is observed by the guard instead of reaching the harness.
    await Promise.resolve();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    if (escapedRejection !== undefined) return undefined;

    return result;
  } catch {
    return undefined;
  } finally {
    armed = false;
    process.off("unhandledRejection", captureUnhandled);
  }
}

/** Discovery links advertised by a page via `<link>` relations. */
interface AdvertisedLinks {
  describedByLink?: string;
  markdownAlternateLink?: string;
}

/**
 * Reads agent-discovery `<link>` relations from an HTML document (llmstxt.org v2):
 * `rel="describedby"` points at the covering `llms.txt`, and
 * `rel="alternate" type="text/markdown"` points at the Markdown version of the page.
 * HREFs are resolved against the page URL; absent or malformed links are omitted.
 */
function readAdvertisedLinks(
  document: ReturnType<typeof parseHTML>["document"],
  baseUrl: URL,
): AdvertisedLinks {
  const resolve = (href: string | null): string | undefined => {
    if (!href) return undefined;

    try {
      return new URL(href, baseUrl.href).href;
    } catch {
      return undefined;
    }
  };

  let describedByLink: string | undefined;
  let markdownAlternateLink: string | undefined;

  for (const link of document.querySelectorAll("link")) {
    const href = resolve(link.getAttribute("href"));

    if (!href) continue;
    const tokens = (link.getAttribute("rel") ?? "").toLowerCase().split(/\s+/);

    if (!describedByLink && tokens.includes("describedby")) describedByLink = href;

    if (
      !markdownAlternateLink &&
      tokens.includes("alternate") &&
      (link.getAttribute("type") ?? "").toLowerCase() === "text/markdown"
    ) {
      markdownAlternateLink = href;
    }
  }

  return { describedByLink, markdownAlternateLink };
}

/**
 * Extracts readable Markdown and an optional title from HTML.
 *
 * @param html - The HTML document to convert
 * @param baseUrl - The absolute base URL used to resolve document-relative links
 * @returns The extracted Markdown, optional title, extractor used, and advertised discovery links
 * @throws When markup exceeds the safe conversion depth
 */
async function extractHtmlDocument(
  html: string,
  baseUrl: URL,
): Promise<{
  markdown: string;
  title?: string;
  extractor: "defuddle" | "basic";
  fragmentOffsets?: Record<string, number>;
  describedByLink?: string;
  markdownAlternateLink?: string;
  githubReadme?: boolean;
  noscriptFallback?: boolean;
}> {
  // Keep refusal outside the catch: the fallback also constructs a DOM.
  assertConversionDepth(html);
  let advertised: AdvertisedLinks = {};
  let fallbackHtml = html;
  let githubReadme = false;
  let emptyScriptedMain = false;

  const omitSparseChrome = (markdown: string): string =>
    emptyScriptedMain && isSparseExtraction(html.length, markdown.length) ? "" : markdown;

  try {
    assertAbsoluteHttpUrl(baseUrl);
    const { document } = parseHTML(html);
    normalizeFragmentDocument(document);
    // Defuddle parses URL metadata without using its explicit page URL as the
    // base. Resolve relative values first so it does not log ERR_INVALID_URL
    // through Pi's TUI even though extraction succeeds.
    resolveDocumentRelativeMetadataUrls(document, baseUrl);
    removeMalformedSchemaOrgData(document);
    const originalIds = new Map<HTMLElement, string>();

    for (const element of document.querySelectorAll<HTMLElement>("[id]")) {
      originalIds.set(element, element.id);
    }

    stripChromeWrappers(document, baseUrl);
    advertised = readAdvertisedLinks(document, baseUrl);
    removeHiddenBodyElements(document);

    githubReadme = isolateGitHubReadme(document, baseUrl);

    if (githubReadme) fallbackHtml = document.documentElement.outerHTML;
    emptyScriptedMain = isSparseExtraction(html.length, 0) && hasEmptyScriptedMain(document);
    normalizeSelectorUnsafeIds(document);
    // Pass the full absolute URL so Defuddle resolves relative links (e.g.
    // `/owner/repo/releases`) and metadata against the real origin instead of
    // dropping the scheme and host and constructing `new URL(pathname)`.
    const result = await runDefuddle(document, baseUrl.href);

    const markdown = stripExtractedCssCruft(
      deduplicateAdjacentLinks(result?.content?.trim() ?? ""),
    );

    const trimmedTitle = result?.title?.trim();

    if (markdown) {
      const visibleMarkdown = omitSparseChrome(markdown);

      return {
        markdown: visibleMarkdown,
        title: trimmedTitle || undefined,
        extractor: "defuddle",
        githubReadme,
        fragmentOffsets: buildFragmentOffsets(document, visibleMarkdown, originalIds),
        ...advertised,
      };
    }
  } catch {
    // Fall through to the basic converter for malformed or unsupported pages.
  }

  const fallbackMarkdown = omitSparseChrome(
    stripExtractedCssCruft(htmlToMarkdownFallback(fallbackHtml)),
  );

  let fragmentOffsets: Record<string, number> = {};

  try {
    fragmentOffsets = buildFragmentOffsets(parseHTML(fallbackHtml).document, fallbackMarkdown);
  } catch {
    // Malformed HTML has already been reduced to plain text; no anchors are available.
  }

  return {
    markdown: fallbackMarkdown,
    extractor: "basic",
    githubReadme,
    fragmentOffsets,
    ...advertised,
  };
}

/** Select only an explicitly requested, unambiguous surface control and sibling panes. */
function selectSurfaceHtml(
  html: string,
  url: URL,
): { html: string; selected: string; omitted: number } | undefined {
  const values = url.searchParams.getAll("tab");

  if (values.length !== 1 || !/^[a-z0-9-]{1,40}$/u.test(values[0])) return undefined;
  const selected = values[0];
  const { document } = parseHTML(html);
  normalizeFragmentDocument(document);
  const candidates: Array<{ panes: Element[]; chosen: Element }> = [];

  // Standard ARIA controls identify their panels by ID. The query value must
  // match a control ID or panel ID exactly; labels are not URL identifiers.
  for (const group of document.querySelectorAll('[role="tablist"]')) {
    const controls = [...group.querySelectorAll('[role="tab"]')].filter(
      (control) => control.closest('[role="tablist"]') === group,
    );

    if (controls.length < 2 || controls.length > 20) continue;
    const ids = controls.map((control) => control.getAttribute("aria-controls") ?? "");

    if (ids.some((id) => !id || /\s/u.test(id)) || new Set(ids).size !== ids.length) continue;

    const panes = ids.map((id) => {
      const matches = [...document.querySelectorAll('[role="tabpanel"][id]')].filter(
        (pane) => pane.getAttribute("id") === id,
      );

      return matches.length === 1 ? matches[0] : undefined;
    });

    if (panes.some((pane) => !pane)) continue;

    const matched = controls.flatMap((control, i) =>
      control.id === selected || ids[i] === selected ? [i] : [],
    );

    if (matched.length !== 1) continue;
    const resolved = panes.filter((pane): pane is Element => pane !== undefined);

    if (resolved.some((pane) => pane.parentElement !== resolved[0].parentElement)) continue;
    candidates.push({ panes: resolved, chosen: resolved[matched[0]] });
  }

  // Some sites use their own explicit surface IDs instead of ARIA references.
  const groups = [...document.querySelectorAll("[data-surface-filter-pills]")];
  const surfacePanes = [...document.querySelectorAll("[data-surface-pane]")];

  if (groups.length === 1 && surfacePanes.length >= 2 && surfacePanes.length <= 20) {
    const controls = [...groups[0].querySelectorAll('[role="tab"][data-surface-id]')];
    const ids = controls.map((control) => control.getAttribute("data-surface-id"));
    const paneIds = surfacePanes.map((pane) => pane.getAttribute("data-surface-pane"));
    const chosen = surfacePanes.find((pane) => pane.getAttribute("data-surface-pane") === selected);

    if (
      controls.length === surfacePanes.length &&
      new Set(ids).size === ids.length &&
      new Set(paneIds).size === paneIds.length &&
      ids.includes(selected) &&
      chosen &&
      ids.every((id) => id && paneIds.includes(id)) &&
      surfacePanes.every((pane) => pane.parentElement === surfacePanes[0].parentElement)
    )
      candidates.push({ panes: surfacePanes, chosen });
  }

  const unique = candidates.filter(
    (candidate, index) =>
      !candidates
        .slice(0, index)
        .some(
          (previous) =>
            previous.chosen === candidate.chosen &&
            previous.panes.length === candidate.panes.length &&
            previous.panes.every((pane) => candidate.panes.includes(pane)),
        ),
  );

  if (unique.length !== 1) return undefined;
  const { panes, chosen } = unique[0];

  if (!chosen?.textContent?.trim()) return undefined;

  for (const pane of panes) if (pane !== chosen) pane.remove();
  // The selected pane may be hidden by the server's default inline state.
  chosen.removeAttribute("hidden");
  chosen.removeAttribute("aria-hidden");
  chosen.removeAttribute("style");

  return { html: document.documentElement.outerHTML, selected, omitted: panes.length - 1 };
}

/** Removes non-selected Android Compose BOM rows from the HTML table. */
export function filterAndroidBomHtml(html: string, version: string): string | undefined {
  const { document } = parseHTML(html);
  const rows = [...document.querySelectorAll<HTMLElement>("tr[filter-value]")];
  const matching = rows.filter((row) => row.getAttribute("filter-value") === version);

  if (matching.length === 0) return undefined;

  for (const row of rows) {
    if (row.getAttribute("filter-value") !== version) row.remove();
  }

  return document.documentElement.outerHTML;
}

/**
 * Builds a standalone document from the page's no-JavaScript fallback blocks, or
 * returns undefined when the page has none. The recovering document is reparsed
 * through the same depth preflight when it is extracted.
 */
function noscriptFallbackHtml(html: string): string | undefined {
  if (!/<noscript[\s>]/i.test(html)) return undefined;

  let sections: string[];

  try {
    const { document } = parseHTML(html);

    sections = [...document.querySelectorAll("noscript")].flatMap((block) => {
      const inner = block.innerHTML.trim();

      return inner.length > 0 ? [inner] : [];
    });
  } catch {
    return undefined;
  }

  return sections.length === 0
    ? undefined
    : `<html><head></head><body>${sections.join("\n")}</body></html>`;
}

/**
 * Reports whether the primary extraction is too weak to represent the page: empty,
 * sparse for its markup, or no more than a JavaScript-required notice.
 */
function isWeakExtraction(html: string, markdown: string): boolean {
  const length = markdown.trim().length;
  const substantive = length >= NOSCRIPT_FALLBACK_MIN_CHARACTERS;

  if (length === 0) return true;

  if (isSparseExtraction(html.length, length) && !substantive) return true;

  return length < NOSCRIPT_PRIMARY_MAX_CHARACTERS && hasJavaScriptMarkers(html) && !substantive;
}

/**
 * Reads the page's authored no-JavaScript fallback when the primary extraction is
 * empty, sparse, or only a JavaScript-required notice. Readable pages keep their
 * primary content, so fallback navigation or notices never replace real content.
 */
async function extractNoscriptFallback(
  html: string,
  baseUrl: URL,
  primary: Awaited<ReturnType<typeof extractHtmlDocument>>,
): Promise<Awaited<ReturnType<typeof extractHtmlDocument>> | undefined> {
  if (!isWeakExtraction(html, primary.markdown)) return undefined;

  const fallbackHtml = noscriptFallbackHtml(html);

  if (!fallbackHtml) return undefined;

  try {
    const fallback = await extractHtmlDocument(fallbackHtml, baseUrl);

    if (
      fallback.markdown.length < NOSCRIPT_FALLBACK_MIN_CHARACTERS ||
      fallback.markdown.length <= primary.markdown.length
    )
      return undefined;

    return {
      ...fallback,
      // The synthesized document has no head metadata of its own.
      title: primary.title ?? fallback.title,
      githubReadme: primary.githubReadme,
      describedByLink: primary.describedByLink ?? fallback.describedByLink,
      markdownAlternateLink: primary.markdownAlternateLink ?? fallback.markdownAlternateLink,
      noscriptFallback: true,
    };
  } catch {
    // A fallback must never make an otherwise readable page unavailable.
    return undefined;
  }
}

/** Extract the complete page and, when explicitly requested, a separate surface view. */
export async function extractHtmlToMarkdown(
  html: string,
  baseUrl: URL,
): Promise<
  Awaited<ReturnType<typeof extractHtmlDocument>> & {
    surfaceView?: {
      selected: string;
      omitted: number;
      markdown: string;
      fragmentOffsets?: Record<string, number>;
    };
  }
> {
  assertConversionDepth(html);
  const primary = await extractHtmlDocument(html, baseUrl);
  const complete = (await extractNoscriptFallback(html, baseUrl, primary)) ?? primary;

  try {
    const surface = selectSurfaceHtml(html, baseUrl);

    if (!surface) return complete;
    const view = await extractHtmlDocument(surface.html, baseUrl);

    if (!view.markdown.trim()) return complete;

    return {
      ...complete,
      surfaceView: {
        selected: surface.selected,
        omitted: surface.omitted,
        markdown: view.markdown,
        fragmentOffsets: view.fragmentOffsets,
      },
    };
  } catch {
    // A derived view must never make an otherwise readable page unavailable.
    return complete;
  }
}
