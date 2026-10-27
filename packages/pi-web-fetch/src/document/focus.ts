const WORD_PATTERN = /[\p{L}\p{N}_+#]+/gu;

const HEADING_PATTERN = /^#{1,6}\s+\S/;

/** Metadata describing deterministic query-focused extraction. */
export interface FocusDetails {
  query: string;
  matchedSections: number;
  totalSections: number;
  omittedSections: number;
  originalCharacters: number;
  focusedCharacters: number;
}

export interface FocusResult {
  markdown: string;
  details: FocusDetails;
}

interface Section {
  markdown: string;
  tokens: string[];
}

interface SplitSections {
  sections: Section[];
  /** Separator that rejoins selected sections; windowed source stays contiguous. */
  separator: "\n" | "\n\n";
}

/** Target size of one section when a block has no headings and no blank lines. */
const WINDOW_TARGET_CHARACTERS = 8_000;

/** Fewest lines a headingless block needs before it is split into windows. */
const WINDOW_MIN_LINES = 80;

/** Fewest characters a headingless block needs before it is split into windows. */
const WINDOW_MIN_CHARACTERS = 12_000;

function tokens(value: string): string[] {
  return (value.toLowerCase().match(WORD_PATTERN) ?? []).filter((token) => token.length > 1);
}

/**
 * Splits one headingless, blank-line-free block into line-aligned windows.
 *
 * Formatted source and log files have neither headings nor blank lines, so treating the
 * whole body as a single section would make focus select everything. Windows are bounded
 * by characters but never cut a line, and short blocks keep their single section.
 */
function splitIntoWindows(block: string): string[] {
  const lines = block.split(/\r?\n/);

  if (lines.length < WINDOW_MIN_LINES && block.length < WINDOW_MIN_CHARACTERS) return [block];

  const windows: string[] = [];
  let current: string[] = [];
  let size = 0;

  for (const line of lines) {
    if (size > 0 && size + line.length + 1 > WINDOW_TARGET_CHARACTERS) {
      windows.push(current.join("\n"));
      current = [];
      size = 0;
    }

    current.push(line);
    size += line.length + 1;
  }

  const last = current.join("\n");

  if (last) windows.push(last);

  return windows.filter(Boolean);
}

/**
 * Splits Markdown into sections. Headings stay attached to their following content; a
 * headingless document falls back to paragraphs, and a headingless block without blank
 * lines falls back to line windows so focused extraction remains useful for plain-text,
 * log, and reformatted-source responses.
 */
function splitSections(markdown: string): SplitSections {
  // Window a standalone fenced source body without leaving partial Markdown fences.
  const fenced = /^( {0,3})(`{3,}|~{3,})([^\n\r]*)\r?\n([\s\S]*?)\r?\n\1\2\s*$/.exec(markdown);

  const hasInteriorClose = fenced?.[4].split(/\r?\n/).some((line) => {
    const close = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);

    return close && close[1][0] === fenced[2][0] && close[1].length >= fenced[2].length;
  });

  if (fenced && !hasInteriorClose) {
    const windows = splitIntoWindows(fenced[4]);

    if (windows.length > 1) {
      return {
        sections: windows.map((window) => ({
          markdown: `${fenced[1]}${fenced[2]}${fenced[3]}\n${window}\n${fenced[1]}${fenced[2]}`,
          tokens: tokens(window),
        })),
        separator: "\n\n",
      };
    }

    return { sections: [{ markdown, tokens: tokens(fenced[4]) }], separator: "\n\n" };
  }

  const blocks = markdown
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  if (blocks.length === 0) return { sections: [], separator: "\n\n" };

  const lines = markdown.split(/\r?\n/);
  let fence: { marker: string; length: number } | undefined;

  const headingLines = lines.map((line) => {
    const match = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(line);

    if (match) {
      if (!fence) fence = { marker: match[1][0], length: match[1].length };
      else if (match[1][0] === fence.marker && match[1].length >= fence.length && !match[2].trim())
        fence = undefined;

      return false;
    }

    return !fence && HEADING_PATTERN.test(line);
  });

  const hasHeadings = headingLines.some(Boolean);

  if (!hasHeadings) {
    // Keep mixed fenced Markdown intact rather than splitting a fence at blank lines.
    if (lines.some((line) => /^[ \t]{0,3}(`{3,}|~{3,})/.test(line))) {
      return { sections: [{ markdown, tokens: tokens(markdown) }], separator: "\n\n" };
    }

    const windowed = blocks.flatMap(splitIntoWindows);

    return {
      sections: windowed.map((block) => ({ markdown: block, tokens: tokens(block) })),
      separator: blocks.length === 1 && windowed.length > 1 ? "\n" : "\n\n",
    };
  }

  const sections: string[] = [];
  let current: string[] = [];

  const flush = () => {
    const section = current.join("\n").trim();

    if (section) sections.push(section);
    current = [];
  };

  for (const [index, line] of lines.entries()) {
    if (headingLines[index]) flush();
    current.push(line);
  }

  flush();

  return {
    sections: sections.map((section) => ({ markdown: section, tokens: tokens(section) })),
    separator: "\n\n",
  };
}

/**
 * Produces a deterministic, query-focused view of Markdown using a compact BM25-style
 * section ranker. Matching sections retain source order so the result remains readable
 * and attributable to the fetched page. The complete document is never mutated.
 */
export function focusMarkdown(markdown: string, query: string): FocusResult {
  const normalizedQuery = query.trim();
  const queryTerms = [...new Set(tokens(normalizedQuery))];
  const { sections, separator } = splitSections(markdown);
  const originalCharacters = markdown.length;

  if (queryTerms.length === 0 || sections.length === 0) {
    return {
      markdown: "",
      details: {
        query: normalizedQuery,
        matchedSections: 0,
        totalSections: sections.length,
        omittedSections: sections.length,
        originalCharacters,
        focusedCharacters: 0,
      },
    };
  }

  const averageLength =
    sections.reduce((sum, section) => sum + section.tokens.length, 0) / sections.length || 1;

  const documentFrequency = new Map<string, number>();

  for (const term of queryTerms) {
    documentFrequency.set(
      term,
      sections.reduce((count, section) => count + (section.tokens.includes(term) ? 1 : 0), 0),
    );
  }

  const selected = sections.filter((section) => {
    const frequencies = new Map<string, number>();

    for (const token of section.tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    const lengthNormalization = 1 - 0.75 + 0.75 * (section.tokens.length / averageLength);
    let score = 0;

    for (const term of queryTerms) {
      const frequency = frequencies.get(term) ?? 0;

      if (frequency === 0) continue;
      const frequencyInDocuments = documentFrequency.get(term) ?? 0;

      const inverseDocumentFrequency = Math.log(
        1 + (sections.length - frequencyInDocuments + 0.5) / (frequencyInDocuments + 0.5),
      );

      score +=
        inverseDocumentFrequency *
        ((frequency * (1.2 + 1)) / (frequency + 1.2 * lengthNormalization));
    }

    return score > 0;
  });

  const focused = selected.map((section) => section.markdown).join(separator);

  return {
    markdown: focused,
    details: {
      query: normalizedQuery,
      matchedSections: selected.length,
      totalSections: sections.length,
      omittedSections: sections.length - selected.length,
      originalCharacters,
      focusedCharacters: focused.length,
    },
  };
}
