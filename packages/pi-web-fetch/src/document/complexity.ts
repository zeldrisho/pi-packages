/**
 * Maximum open-element depth accepted for synchronous HTML extraction.
 * Network byte limits do not bound the cost of DOM construction or tree walks;
 * cooperative cancellation cannot interrupt that work on the event loop.
 */
export const MAX_CONVERSION_DEPTH = 512;

/** HTML void elements do not grow the open-element stack. */
const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

// Match linkedom's raw-text handling, not the browser's scripting-enabled parser:
// in particular, linkedom parses nested elements inside <noscript>.
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea"]);

/**
 * Finds a raw-text end tag in lowercased HTML, starting at the supplied code-unit
 * offset, without interpreting its body as markup. Returns -1 when none is found.
 */
function findRawTextEnd(html: string, name: string, from: number): number {
  const prefix = `</${name}`;
  let candidate = html.indexOf(prefix, from);

  while (candidate !== -1) {
    const boundary = html[candidate + prefix.length];

    if (boundary === undefined || boundary === ">" || boundary === "/" || /\s/u.test(boundary))
      return candidate;

    candidate = html.indexOf(prefix, candidate + prefix.length);
  }

  return -1;
}

/**
 * Conservatively checks lexical HTML depth in one pass, before creating a DOM.
 * Only a matching top-of-stack closing tag reduces depth. Self-closing syntax
 * on non-void HTML elements is counted as opening, just as linkedom treats it.
 * Quoted attributes, comments, and raw-text bodies cannot hide nested markup.
 */
export function exceedsConversionDepth(html: string): boolean {
  const lower = html.toLowerCase();
  const stack: string[] = [];
  let offset = 0;

  while (offset < html.length) {
    const start = html.indexOf("<", offset);

    if (start === -1) break;

    if (html.startsWith("<!--", start)) {
      const end = html.indexOf("-->", start + 4);

      if (end === -1) break;

      offset = end + 3;
      continue;
    }

    let cursor = start + 1;
    const closing = html[cursor] === "/";

    if (closing) cursor += 1;
    const nameStart = cursor;

    while (/[a-zA-Z0-9:-]/u.test(html[cursor] ?? "")) cursor += 1;

    if (cursor === nameStart || !/[a-zA-Z]/u.test(html.charAt(nameStart))) {
      offset = start + 1;
      continue;
    }

    const name = lower.slice(nameStart, cursor);
    let quote: '"' | "'" | undefined;

    while (cursor < html.length) {
      const character = html[cursor++];

      if (quote !== undefined) {
        if (character === quote) quote = undefined;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === ">") {
        break;
      }
    }

    if (html[cursor - 1] !== ">") break;

    if (closing) {
      if (stack.at(-1) === name) stack.pop();
    } else if (!VOID_ELEMENTS.has(name)) {
      stack.push(name);

      if (stack.length > MAX_CONVERSION_DEPTH) return true;

      if (RAW_TEXT_ELEMENTS.has(name)) {
        const end = findRawTextEnd(lower, name, cursor);

        if (end === -1) break;

        offset = end;
        continue;
      }
    }

    offset = cursor;
  }

  return false;
}

/**
 * Refuses excessive nesting before fallback or diagnostic DOM parsing.
 *
 * @throws {Error} When lexical depth exceeds MAX_CONVERSION_DEPTH (512 open elements)
 */
export function assertConversionDepth(html: string): void {
  if (exceedsConversionDepth(html)) {
    throw new Error(
      `web_fetch: HTML nesting exceeds the safe extraction depth (${MAX_CONVERSION_DEPTH}).`,
    );
  }
}
