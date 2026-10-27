/**
 * Source text that is read as code rather than prose, mapped to the code-fence
 * language used when one of these bodies is reformatted.
 */
const SOURCE_LANGUAGE_BY_CONTENT_TYPE = {
  "application/json": "json",
  "text/javascript": "js",
  "text/yaml": "yaml",
} as const;

type SourceContentType = keyof typeof SOURCE_LANGUAGE_BY_CONTENT_TYPE;

/** Narrows a media type to the source types that are reformatted. */
function isSourceContentType(value: string): value is SourceContentType {
  return Object.hasOwn(SOURCE_LANGUAGE_BY_CONTENT_TYPE, value);
}

/** Shortest body reformatted; below this a page is returned verbatim. */
const MINIFIED_MIN_CHARACTERS = 2_000;

/**
 * Largest body reformatted. Reformatting triples transient memory for a document too
 * large to cache, so bigger bodies keep their original single-line layout.
 */
const MINIFIED_MAX_CHARACTERS = 2 * 1_024 * 1_024;

/**
 * Shortest average line that still counts as machine-generated. Bundled source is
 * packed into very long lines even when it keeps a few real line breaks inside block
 * scalars, while hand-written source keeps short lines.
 */
const MINIFIED_MIN_AVERAGE_LINE_CHARACTERS = 300;

/** Deepest nesting that still receives extra indentation. */
const MAX_FORMAT_DEPTH = 24;

const INDENT = "  ";

const QUOTE_CHARACTERS = new Set(['"', "'", "`"]);

const OPENING_CHARACTERS = new Set(["{", "["]);

const CLOSING_CHARACTERS = new Set(["}", "]"]);

const LINE_ENDING_CHARACTERS = new Set([",", ";"]);

/**
 * Returns whether a body is machine-generated source rather than hand-written code.
 *
 * Only minified bodies are reformatted: a hand-written file already carries the
 * author's line structure, which is more useful than any generated layout.
 */
function isMinified(value: string): boolean {
  if (value.length < MINIFIED_MIN_CHARACTERS || value.length > MINIFIED_MAX_CHARACTERS)
    return false;

  let lineBreaks = 0;

  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\n") lineBreaks += 1;
  }

  return value.length / (lineBreaks + 1) >= MINIFIED_MIN_AVERAGE_LINE_CHARACTERS;
}

/** Returns the fence language for a content type, or undefined when it is not source. */
export function sourceLanguageFor(contentType: string): string | undefined {
  return isSourceContentType(contentType)
    ? SOURCE_LANGUAGE_BY_CONTENT_TYPE[contentType]
    : undefined;
}

/**
 * Adds line breaks and indentation to minified source without interpreting it.
 *
 * Layout whitespace is normalized and every other character is preserved in order.
 * String literals are tracked only far enough to keep their punctuation from changing
 * the layout, so no value is parsed, evaluated, or re-serialized.
 *
 * @param value - The minified source
 * @returns Indented source, or undefined when the input was not minified
 */
export function indentMinifiedSource(value: string): string | undefined {
  if (!isMinified(value)) return undefined;

  const lines: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;

  const indent = (): string => INDENT.repeat(Math.min(depth, MAX_FORMAT_DEPTH));

  const flush = (): void => {
    const line = current.trimEnd();

    if (line) lines.push(line);
    current = "";
  };

  for (const character of value) {
    if (quote !== undefined) {
      current += character;

      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;

      continue;
    }

    if (QUOTE_CHARACTERS.has(character)) {
      quote = character;
      current += character;

      continue;
    }

    if (OPENING_CHARACTERS.has(character)) {
      current += character;
      flush();
      depth += 1;
      current = indent();

      continue;
    }

    if (CLOSING_CHARACTERS.has(character)) {
      flush();
      depth = Math.max(0, depth - 1);
      current = indent() + character;

      continue;
    }

    if (LINE_ENDING_CHARACTERS.has(character)) {
      current += character;
      flush();
      current = indent();

      continue;
    }

    if (character === "\n") {
      flush();
      current = indent();

      continue;
    }

    if (character !== "\r") current += character;
  }

  flush();

  return lines.join("\n");
}

/**
 * Reformats minified JavaScript, JSON, or YAML as a fenced code block.
 *
 * @param raw - The decoded response body
 * @param contentType - The normalized response media type
 * @returns A fenced, indented Markdown block, or undefined when the body is not
 *   source that benefits from reformatting
 */
export function formatMinifiedSource(
  raw: string,
  contentType: string,
): { markdown: string; language: string } | undefined {
  const language = sourceLanguageFor(contentType);

  if (language === undefined) return undefined;

  const indented = indentMinifiedSource(raw);

  if (indented === undefined) return undefined;

  return { language, markdown: `\`\`\`${language}\n${indented}\n\`\`\`` };
}
