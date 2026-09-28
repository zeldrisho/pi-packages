const CSS_BLOCK_AT_RULE = /^\s*@(container|font-face|keyframes|layer|media|page|supports)\b/i;

const STANDALONE_CSS_RULE =
  /^\s*(?:[.#][-_a-zA-Z]|\*\s*[.#:[>+~]|(?:html|body|main|article|nav|header|footer|aside)(?:\b|[.#:[>+~]))[^{}]*\{[^{}]*\}\s*$/i;

const COMPLETE_STYLE_ELEMENT = /<style\b[^>]*>[\s\S]*?<\/style\s*>/gi;

const CLOSING_STYLE_ELEMENT = /<\/style\s*>/i;

const OPENING_STYLE_ELEMENT = /<style\b[^>]*>/i;

/**
 * Iteratively removes complete style elements from a string to prevent nested fragment recreation.
 *
 * @param value - The string to strip style elements from
 * @returns The string with all complete style elements removed
 */
function stripCompleteStyleElements(value: string): string {
  let cleaned = value;

  while (true) {
    const next = cleaned.replace(COMPLETE_STYLE_ELEMENT, "");

    if (next === cleaned) return cleaned;
    cleaned = next;
  }
}

/**
 * Calculates the net brace depth change in a string (opening braces minus closing braces).
 *
 * @param value - The string to analyze
 * @returns The difference between opening and closing brace counts
 */
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
  let fence: { character: string; length: number } | undefined;
  let styleElement = false;
  let cssBlockDepth = 0;

  for (const originalLine of markdown.split("\n")) {
    const fenceMatch = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(originalLine);

    if (!fence && fenceMatch) {
      fence = { character: fenceMatch[1][0], length: fenceMatch[1].length };
      output.push(originalLine);
      continue;
    }

    if (fence) {
      output.push(originalLine);

      if (
        fenceMatch &&
        fenceMatch[1][0] === fence.character &&
        fenceMatch[1].length >= fence.length &&
        !originalLine.slice(fenceMatch[0].length).trim()
      ) {
        fence = undefined;
      }

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
