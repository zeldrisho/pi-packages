import { parseHTML } from "linkedom";

const RAW_ID_SELECTOR_SAFE = /^-?[_a-zA-Z][-_a-zA-Z0-9]*$/;

function normalizeSelectorUnsafeIds(document: Document): void {
  const replacements = new Map<string, string>();
  let replacementIndex = 0;

  for (const element of document.querySelectorAll<HTMLElement>("[id]")) {
    const id = element.id;
    if (!id || RAW_ID_SELECTOR_SAFE.test(id)) continue;

    const replacement = `defuddle-safe-id-${replacementIndex++}`;
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

export async function extractHtmlToMarkdown(
  html: string,
  baseUrl: URL,
): Promise<{ markdown: string; title?: string; extractor: "defuddle" | "basic" }> {
  try {
    const { Defuddle } = await import("defuddle/node");
    const { document } = parseHTML(html);
    normalizeSelectorUnsafeIds(document as unknown as Document);
    const result = await Defuddle(document as unknown as Document, baseUrl.toString(), {
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
