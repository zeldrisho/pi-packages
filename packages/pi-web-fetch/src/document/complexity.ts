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

/** Form elements that close each other in linkedom's parser, mirroring htmlparser2. */
const FORM_ELEMENTS = new Set([
  "input",
  "option",
  "optgroup",
  "select",
  "button",
  "datalist",
  "textarea",
]);

const P_TAG = new Set(["p"]);

/**
 * Start tags that imply an end tag, mapped to the tags they close, mirroring
 * htmlparser2's `openImpliesClose` table used by linkedom. A tag closes only while it
 * is on top of the open-element stack; an intervening element keeps it open.
 */
const IMPLIED_END_TAGS = new Map<string, ReadonlySet<string>>([
  ["tr", new Set(["tr", "th", "td"])],
  ["th", new Set(["th"])],
  ["td", new Set(["thead", "th", "td"])],
  ["body", new Set(["head", "link", "script"])],
  ["li", new Set(["li"])],
  ["p", P_TAG],
  ["h1", P_TAG],
  ["h2", P_TAG],
  ["h3", P_TAG],
  ["h4", P_TAG],
  ["h5", P_TAG],
  ["h6", P_TAG],
  ["select", FORM_ELEMENTS],
  ["input", FORM_ELEMENTS],
  ["output", FORM_ELEMENTS],
  ["button", FORM_ELEMENTS],
  ["datalist", FORM_ELEMENTS],
  ["textarea", FORM_ELEMENTS],
  ["option", new Set(["option"])],
  ["optgroup", new Set(["optgroup", "option"])],
  ["dd", new Set(["dd", "dt"])],
  ["dt", new Set(["dd", "dt"])],
  ["address", P_TAG],
  ["article", P_TAG],
  ["aside", P_TAG],
  ["blockquote", P_TAG],
  ["details", P_TAG],
  ["div", P_TAG],
  ["dl", P_TAG],
  ["fieldset", P_TAG],
  ["figcaption", P_TAG],
  ["figure", P_TAG],
  ["footer", P_TAG],
  ["form", P_TAG],
  ["header", P_TAG],
  ["hr", P_TAG],
  ["main", P_TAG],
  ["nav", P_TAG],
  ["ol", P_TAG],
  ["pre", P_TAG],
  ["section", P_TAG],
  ["table", P_TAG],
  ["ul", P_TAG],
  ["rt", new Set(["rt", "rp"])],
  ["rp", new Set(["rt", "rp"])],
  ["tbody", new Set(["thead", "tbody"])],
  ["tfoot", new Set(["thead", "tbody"])],
] satisfies Array<[string, ReadonlySet<string>]>);

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
 * documents whose `p`, `li`, or `td` end tags are omitted would be refused. An implied
 * close applies only while its tag is on top of the stack, matching linkedom's parser,
 * so an intervening element keeps counting toward depth. Self-closing syntax on non-void
 * HTML elements is counted as opening, just as linkedom treats it, while foreign content
 * (`svg`, `math`) honors it.
 * Quoted attributes, comments, and raw-text bodies cannot hide nested markup.
 */
export function exceedsConversionDepth(html: string): boolean {
  // Preserve code-unit positions when normalizing ASCII tag names.
  const lower = html.replace(/[A-Z]+/g, (match) => match.toLowerCase());
  const stack: string[] = [];
  let foreignDepth = 0;
  let offset = 0;

  const push = (name: string): void => {
    stack.push(name);

    if (FOREIGN_ROOTS.has(name)) foreignDepth += 1;
  };

  const pop = (): void => {
    const name = stack.pop();

    if (name === undefined) return;

    if (FOREIGN_ROOTS.has(name)) foreignDepth -= 1;
  };

  // The scan is charged to the elements it pops, so total work stays linear.
  const closeImplied = (name: string): void => {
    const implied = IMPLIED_END_TAGS.get(name);

    if (implied === undefined) return;

    // linkedom closes an implied end tag only while it is on top of its own stack.
    while (stack.length > 0) {
      const top = stack.at(-1);

      if (top === undefined || !implied.has(top)) return;

      pop();
    }
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
