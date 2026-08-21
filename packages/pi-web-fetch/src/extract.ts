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

/**
 * Runs Defuddle on a normalized document with Markdown extraction enabled.
 *
 * @param document - The normalized document to process
 * @param pageUrl - The absolute page URL used to resolve relative links
 * @returns The extracted Defuddle response, or `undefined` if extraction fails
 */
async function runDefuddle(
  document: Document,
  pageUrl: string,
): Promise<DefuddleResponse | undefined> {
  let escapedRejection: unknown = undefined;
  // `cause` is the unhandled rejection's reason — the cause of the Defuddle
  // failure we capture so the caller can fall back instead of crashing.
  const captureUnhandled = (cause: unknown): void => {
    if (escapedRejection === undefined) escapedRejection = cause;
  };
  process.on("unhandledRejection", captureUnhandled);
  try {
    const { Defuddle } = await import("defuddle/node");
    const result = await Defuddle(document, pageUrl, { markdown: true, useAsync: false });
    // Let any promise Defuddle scheduled after resolving settle so a detached
    // rejection is observed by the guard above instead of reaching the harness.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (escapedRejection !== undefined) throw escapedRejection;
    return result;
  } catch {
    return undefined;
  } finally {
    process.off("unhandledRejection", captureUnhandled);
  }
}

/**
 * Extracts readable Markdown and an optional title from HTML.
 *
 * @param html - The HTML document to convert
 * @param baseUrl - The absolute base URL used to resolve document-relative links
 * @returns The extracted Markdown, optional title, and extractor used
 */
export async function extractHtmlToMarkdown(
  html: string,
  baseUrl: URL,
): Promise<{ markdown: string; title?: string; extractor: "defuddle" | "basic" }> {
  try {
    const { document } = parseHTML(html);
    removeMalformedSchemaOrgData(document);
    normalizeSelectorUnsafeIds(document);
    // Pass the full absolute URL so Defuddle resolves relative links (e.g.
    // `/owner/repo/releases`) and metadata against the real origin instead of
    // dropping the scheme and host and constructing `new URL(pathname)`.
    const result = await runDefuddle(document, baseUrl.href);
    const markdown = result?.content?.trim() ?? "";
    const trimmedTitle = result?.title?.trim();
    if (markdown) {
      return {
        markdown,
        title: trimmedTitle || undefined,
        extractor: "defuddle",
      };
    }
  } catch {
    // Fall through to the basic converter for malformed or unsupported pages.
  }
  return { markdown: htmlToMarkdownFallback(html), extractor: "basic" };
}
