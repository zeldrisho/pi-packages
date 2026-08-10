import { parseHTML } from "linkedom";

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
 * Extracts readable Markdown and an optional title from HTML.
 *
 * @param html - The HTML document to convert
 * @param baseUrl - The base URL used to resolve document-relative links
 * @returns The extracted Markdown, optional title, and extractor used
 */
export async function extractHtmlToMarkdown(
  html: string,
  baseUrl: URL,
): Promise<{ markdown: string; title?: string; extractor: "defuddle" | "basic" }> {
  try {
    const { Defuddle } = await import("defuddle/node");
    const { document } = parseHTML(html);
    const defuddleDocument = document as unknown as Document;
    removeMalformedSchemaOrgData(defuddleDocument);
    normalizeSelectorUnsafeIds(defuddleDocument);
    const result = await Defuddle(defuddleDocument, baseUrl.toString(), {
      markdown: true,
      useAsync: false,
    });
    const markdown = typeof result.content === "string" ? result.content.trim() : "";
    if (markdown) {
      return {
        markdown,
        title:
          typeof result.title === "string" && result.title.trim() ? result.title.trim() : undefined,
        extractor: "defuddle",
      };
    }
  } catch {
    // Fall through to the basic converter for malformed or unsupported pages.
  }
  return { markdown: htmlToMarkdownFallback(html), extractor: "basic" };
}
