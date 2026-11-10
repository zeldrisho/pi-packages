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

/** Elements whose end tag may be omitted, mapped to the start tags that close them. */
const IMPLIED_END_TAGS = new Map<string, ReadonlySet<string>>(
  Object.entries({
    li: ["li"],
    dt: ["dt", "dd"],
    dd: ["dt", "dd"],
    td: ["td", "th"],
    th: ["td", "th"],
    tr: ["td", "th", "tr"],
    thead: ["td", "th", "tr", "thead", "tbody", "tfoot"],
    tbody: ["td", "th", "tr", "thead", "tbody", "tfoot"],
    tfoot: ["td", "th", "tr", "thead", "tbody", "tfoot"],
    option: ["option"],
    optgroup: ["option", "optgroup"],
    rt: ["rt", "rp"],
    rp: ["rt", "rp"],
  }).map(([name, closed]) => [name, new Set(closed)]),
);

/** Start tags that implicitly close an open `p`, per the HTML parsing rules. */
const CLOSES_PARAGRAPH = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "details",
  "div",
  "dl",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "main",
  "menu",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "ul",
]);

const PARAGRAPH = new Set(["p"]);

/**
 * Elements that open foreign content, where self-closing syntax is honored.
 * In HTML content a trailing `/` is ignored, matching linkedom and the HTML rules.
 */
const FOREIGN_ROOTS = new Set(["svg", "math"]);

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
 * Only a matching top-of-stack closing tag reduces depth, plus the implied end tags
 * that linkedom itself applies for optional-end-tag elements; without those, ordinary
 * documents whose `p`, `li`, or `td` end tags are omitted would be refused. Self-closing
 * syntax on non-void HTML elements is counted as opening, just as linkedom treats it,
 * while foreign content (`svg`, `math`) honors it.
 * Quoted attributes, comments, and raw-text bodies cannot hide nested markup.
 */
export function exceedsConversionDepth(html: string): boolean {
  // Preserve code-unit positions when normalizing ASCII tag names.
  const lower = html.replace(/[A-Z]+/g, (match) => match.toLowerCase());
  const stack: string[] = [];
  const open = new Map<string, number>();
  let foreignDepth = 0;
  let offset = 0;

  const push = (name: string): void => {
    stack.push(name);
    open.set(name, (open.get(name) ?? 0) + 1);

    if (FOREIGN_ROOTS.has(name)) foreignDepth += 1;
  };

  const pop = (): void => {
    const name = stack.pop();

    if (name === undefined) return;
    const remaining = (open.get(name) ?? 1) - 1;

    if (remaining === 0) open.delete(name);
    else open.set(name, remaining);

    if (FOREIGN_ROOTS.has(name)) foreignDepth -= 1;
  };

  const hasOpen = (names: ReadonlySet<string>): boolean => {
    for (const name of names) {
      if (open.has(name)) return true;
    }

    return false;
  };

  // The scan is charged to the elements it pops, so total work stays linear.
  const popThrough = (names: ReadonlySet<string>): void => {
    let target = -1;

    for (let index = stack.length - 1; index >= 0; index -= 1) {
      if (names.has(stack[index])) {
        target = index;
        break;
      }
    }

    if (target === -1) return;

    while (stack.length > target) pop();
  };

  const closeImplied = (name: string): void => {
    const implied = IMPLIED_END_TAGS.get(name);

    if (implied !== undefined && hasOpen(implied)) popThrough(implied);

    if (CLOSES_PARAGRAPH.has(name) && open.has("p")) popThrough(PARAGRAPH);
  };

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
    let expectingValue = false;
    let unquotedValue = false;

    while (cursor < html.length) {
      const character = html[cursor++];

      if (quote !== undefined) {
        if (character === quote) quote = undefined;
      } else if (unquotedValue) {
        if (character === ">") break;

        if (/[\t\n\f\r ]/u.test(character)) unquotedValue = false;
      } else if (expectingValue) {
        if (/[\t\n\f\r ]/u.test(character)) continue;
        expectingValue = false;

        if (character === '"' || character === "'") {
          quote = character;
        } else if (character === ">") {
          break;
        } else {
          unquotedValue = true;
        }
      } else if (character === "=") {
        expectingValue = true;
      } else if (character === ">") {
        break;
      }
    }

    if (html[cursor - 1] !== ">") break;

    if (closing) {
      if (stack.at(-1) === name) pop();
    } else if (!VOID_ELEMENTS.has(name)) {
      // Self-closing syntax is honored only for foreign content; linkedom ignores a
      // trailing `/` on HTML elements, so those must still count as opening.
      if (html[cursor - 2] === "/" && (foreignDepth > 0 || FOREIGN_ROOTS.has(name))) {
        offset = cursor;
        continue;
      }

      // Inside foreign content these elements are not HTML, so no implied end tags apply.
      if (foreignDepth === 0) closeImplied(name);
      push(name);

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
