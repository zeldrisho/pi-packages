import { parseHTML } from "linkedom";
import type { DefuddleResponse } from "defuddle/node";

const RAW_ID_SELECTOR_SAFE = /^-?[_a-zA-Z][-_a-zA-Z0-9]*$/;

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

/**
 * Extracts normalized plain text from HTML when structured Markdown extraction is unavailable.
 *
 * @param html - The HTML content to convert
 * @returns The trimmed text content with excluded elements and excessive whitespace removed
 */
export function htmlToMarkdownFallback(html: string): string {
  const { document } = parseHTML(html);
  for (const element of document.querySelectorAll(
    "script, style, svg, noscript, template, iframe, nav, header, footer, aside, form",
  )) {
    element.remove();
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
    if (content) meta.setAttribute("content", new URL(content, pageUrl).href);
  }

  for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="canonical"][href]')) {
    const href = link.getAttribute("href");
    if (href) link.setAttribute("href", new URL(href, pageUrl).href);
  }
}

/**
 * Type guard that checks if an unknown value is a string.
 *
 * @param value - The value to check
 * @returns `true` if the value is a string
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- type-guard helper intentionally narrows unknown at call site
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
  // SAFETY: Error.stack is an optional string populated by V8; we coerce it for pattern matching.
  const detail = `${cause.message}\n${(cause as Error).stack ?? ""}`;
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

const CSS_BLOCK_AT_RULE = /^\s*@(container|font-face|keyframes|layer|media|page|supports)\b/i;
const STANDALONE_CSS_RULE =
  /^\s*(?:[.#][-_a-zA-Z]|\*\s*[.#:[>+~]|(?:html|body|main|article|nav|header|footer|aside)(?:\b|[.#:[>+~]))[^{}]*\{[^{}]*\}\s*$/i;
const COMPLETE_STYLE_ELEMENT = /<style\b[^>]*>[\s\S]*?<\/style\s*>/gi;
const CLOSING_STYLE_ELEMENT = /<\/style\s*>/i;
const OPENING_STYLE_ELEMENT = /<style\b[^>]*>/i;

function stripCompleteStyleElements(value: string): string {
  let cleaned = value;
  while (true) {
    const next = cleaned.replace(COMPLETE_STYLE_ELEMENT, "");
    if (next === cleaned) return cleaned;
    cleaned = next;
  }
}

function braceDelta(value: string): number {
  return (value.match(/{/g)?.length ?? 0) - (value.match(/}/g)?.length ?? 0);
}

/**
 * Removes leaked stylesheet fragments from extracted Markdown while preserving fenced examples.
 *
 * The matcher is deliberately conservative: it removes style elements, recognized block at-rules,
 * and complete standalone selector/declaration lines. Prose that merely discusses CSS and fenced
 * CSS/SCSS/Less examples remain untouched.
 */
export function stripExtractedCssCruft(markdown: string): string {
  const output: string[] = [];
  let fence: string | undefined;
  let styleElement = false;
  let cssBlockDepth = 0;

  for (const originalLine of markdown.split("\n")) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(originalLine);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!fence) fence = marker;
      else if (fence === marker) fence = undefined;
      output.push(originalLine);
      continue;
    }
    if (fence) {
      output.push(originalLine);
      continue;
    }

    let line = originalLine;
    if (styleElement) {
      const close = CLOSING_STYLE_ELEMENT.exec(line);
      if (!close) continue;
      line = line.slice(close.index + close[0].length);
      styleElement = false;
    }
    line = stripCompleteStyleElements(line);
    const open = OPENING_STYLE_ELEMENT.exec(line);
    if (open) {
      line = line.slice(0, open.index);
      styleElement = true;
    }

    if (cssBlockDepth > 0) {
      cssBlockDepth += braceDelta(line);
      if (cssBlockDepth < 0) cssBlockDepth = 0;
      continue;
    }
    if (CSS_BLOCK_AT_RULE.test(line)) {
      cssBlockDepth = Math.max(0, braceDelta(line));
      continue;
    }
    if (STANDALONE_CSS_RULE.test(line)) continue;
    output.push(line);
  }

  return output
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
    const result = await Defuddle(document, pageUrl, { markdown: true, useAsync: false });
    // Let Defuddle's scheduled microtask/macrotask work settle so a detached
    // rejection is observed by the guard instead of reaching the harness.
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (escapedRejection !== undefined) throw escapedRejection;
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
 * @returns The extracted Markdown, optional title, extractor used, and any advertised
 *   discovery links resolved against the base URL
 */
export async function extractHtmlToMarkdown(
  html: string,
  baseUrl: URL,
): Promise<{
  markdown: string;
  title?: string;
  extractor: "defuddle" | "basic";
  describedByLink?: string;
  markdownAlternateLink?: string;
}> {
  let advertised: AdvertisedLinks = {};
  try {
    assertAbsoluteHttpUrl(baseUrl);
    const { document } = parseHTML(html);
    // Defuddle parses URL metadata without using its explicit page URL as the
    // base. Resolve relative values first so it does not log ERR_INVALID_URL
    // through Pi's TUI even though extraction succeeds.
    resolveDocumentRelativeMetadataUrls(document, baseUrl);
    removeMalformedSchemaOrgData(document);
    normalizeSelectorUnsafeIds(document);
    stripChromeWrappers(document, baseUrl);
    advertised = readAdvertisedLinks(document, baseUrl);
    // Pass the full absolute URL so Defuddle resolves relative links (e.g.
    // `/owner/repo/releases`) and metadata against the real origin instead of
    // dropping the scheme and host and constructing `new URL(pathname)`.
    const result = await runDefuddle(document, baseUrl.href);
    const markdown = stripExtractedCssCruft(
      deduplicateAdjacentLinks(result?.content?.trim() ?? ""),
    );
    const trimmedTitle = result?.title?.trim();
    if (markdown) {
      return {
        markdown,
        title: trimmedTitle || undefined,
        extractor: "defuddle",
        ...advertised,
      };
    }
  } catch {
    // Fall through to the basic converter for malformed or unsupported pages.
  }
  return {
    markdown: stripExtractedCssCruft(htmlToMarkdownFallback(html)),
    extractor: "basic",
    ...advertised,
  };
}
