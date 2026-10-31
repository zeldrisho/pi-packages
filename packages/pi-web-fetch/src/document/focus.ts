const WORD_PATTERN = /[\p{L}\p{N}_+#]+/gu;

const HEADING_PATTERN = /^(?:#{1,6}\s+\S| {0,3}<h[1-6](?:\s[^>]*|)>)/i;

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
const WINDOW_MIN_CHARACTERS = 6_000;

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "for",
  "how",
  "in",
  "is",
  "of",
  "on",
  "the",
  "to",
  "with",
]);

function tokens(value: string): string[] {
  return (value.toLowerCase().match(WORD_PATTERN) ?? []).map((word) => {
    if (word.length > 6 && word.endsWith("ion")) return word.slice(0, -3);

    if (word.length > 4 && /(?:ing|ed)$/.test(word)) return word.replace(/(?:ing|ed)$/, "");

    if (word.length > 4 && /(?:ch|sh|v)e$/.test(word)) return word.slice(0, -1);

    if (word.length > 4 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);

    return word;
  });
}

function containsIdentifier(markdown: string, identifier: string): boolean {
  const text = markdown.toLowerCase();
  let index = text.indexOf(identifier);

  while (index !== -1) {
    const before = text[index - 1] ?? "";
    const after = text[index + identifier.length] ?? "";

    const beforeWord =
      /[\p{L}\p{N}_+#-]/u.test(before) ||
      (before === "." && /[\p{L}\p{N}]/u.test(text[index - 2] ?? ""));

    const afterWord =
      /[\p{L}\p{N}_+#-]/u.test(after) ||
      (after === "." && /[\p{L}\p{N}]/u.test(text[index + identifier.length + 1] ?? ""));

    if (!beforeWord && !afterWord) return true;
    index = text.indexOf(identifier, index + 1);
  }

  return false;
}

/** Split long lines at whitespace without breaking identifiers or surrogate pairs. */
function splitLongLine(line: string): string[] {
  const parts: string[] = [];
  let start = 0;
  const target = WINDOW_TARGET_CHARACTERS / 2;

  while (line.length - start > target) {
    let end = start + target;

    while (end > start && !/\s/u.test(line[end])) end -= 1;

    if (end === start) {
      end = start + target;

      while (end < line.length && !/\s/u.test(line[end])) end += 1;
    }

    if (end >= line.length) break;
    parts.push(line.slice(start, end));
    start = end;
  }

  if (start < line.length) parts.push(line.slice(start));

  return parts;
}

/**
 * Splits headingless blocks into line-aligned windows, splitting long lines at
 * whitespace when possible. Unbroken tokens stay intact even if oversized.
 */
function splitIntoWindows(block: string): string[] {
  const lines = block.split(/\r?\n/);

  if (lines.length < WINDOW_MIN_LINES && block.length < WINDOW_MIN_CHARACTERS) return [block];

  const windows: string[] = [];
  let current: string[] = [];
  let size = 0;

  for (const line of lines) {
    if (line.length > WINDOW_TARGET_CHARACTERS / 2) {
      if (current.length) windows.push(current.join("\n"));
      current = [];
      size = 0;

      windows.push(...splitLongLine(line));
      continue;
    }

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
    // Split mixed prose and fenced blocks only at blank lines outside fences.
    if (lines.some((line) => /^[ \t]{0,3}(`{3,}|~{3,})/.test(line))) {
      const parts: string[] = [];
      let current: string[] = [];
      let fence: { marker: string; length: number } | undefined;

      for (const line of lines) {
        const match = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(line);

        if (match) {
          if (!fence) fence = { marker: match[1][0], length: match[1].length };
          else if (
            match[1][0] === fence.marker &&
            match[1].length >= fence.length &&
            !match[2].trim()
          )
            fence = undefined;
        }

        if (!fence && !line.trim()) {
          const part = current.join("\n").trim();

          if (part) parts.push(part);
          current = [];
        } else current.push(line);
      }

      const part = current.join("\n").trim();

      if (part) parts.push(part);

      return {
        sections: parts.map((part) => ({ markdown: part, tokens: tokens(part) })),
        separator: "\n\n",
      };
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

  // Split oversized sections at blank lines outside fences, so matches do not pull
  // in an entire chapter. Keep the heading with its first content block.
  const bounded = sections.flatMap((section) => {
    if (section.length <= WINDOW_MIN_CHARACTERS) return [section];
    const chunks: string[] = [];
    let current: string[] = [];
    let size = 0;
    let inFence: { marker: string; length: number } | undefined;

    for (const line of section.split("\n")) {
      const match = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(line);

      if (match) {
        if (!inFence) inFence = { marker: match[1][0], length: match[1].length };
        else if (
          match[1][0] === inFence.marker &&
          match[1].length >= inFence.length &&
          !match[2].trim()
        )
          inFence = undefined;
      }

      if (!inFence && line.length > WINDOW_TARGET_CHARACTERS / 2) {
        if (current.length) chunks.push(current.join("\n").trim());
        current = [];
        size = 0;

        chunks.push(...splitLongLine(line));
      } else if (!inFence && !line.trim() && size >= WINDOW_TARGET_CHARACTERS / 2) {
        const chunk = current.join("\n").trim();

        if (chunk) chunks.push(chunk);
        current = [];
        size = 0;
      } else {
        current.push(line);
        size += line.length + 1;
      }
    }

    const chunk = current.join("\n").trim();

    if (chunk) chunks.push(chunk);

    return chunks;
  });

  return {
    sections: bounded.map((section) => ({ markdown: section, tokens: tokens(section) })),
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
  const allTerms = [...new Set(tokens(normalizedQuery))];
  const meaningfulTerms = allTerms.filter((term) => !STOP_WORDS.has(term));
  const queryTerms = meaningfulTerms.length ? meaningfulTerms : allTerms;
  const { sections, separator } = splitSections(markdown);
  const originalCharacters = markdown.length;

  if (!normalizedQuery || sections.length === 0) {
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

  // Punctuated identifiers and flags are literal, never broad component searches.
  const literalIdentifier =
    !/\s/u.test(normalizedQuery) && /[.\-/]/u.test(normalizedQuery)
      ? normalizedQuery.toLowerCase()
      : undefined;

  const scores = sections.map((section) => {
    if (literalIdentifier) return containsIdentifier(section.markdown, literalIdentifier) ? 1 : 0;
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

    return score;
  });

  const highestScore = scores.reduce((highest, score) => Math.max(highest, score), 0);

  const selected = sections.filter(
    (_, index) => scores[index] > 0 && scores[index] >= highestScore * 0.5,
  );

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
