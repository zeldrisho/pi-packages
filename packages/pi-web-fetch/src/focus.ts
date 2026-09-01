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

function tokens(value: string): string[] {
  return (value.toLocaleLowerCase().match(WORD_PATTERN) ?? []).filter((token) => token.length > 1);
}

/**
 * Splits Markdown into sections. Headings stay attached to their following content; a
 * headingless document falls back to paragraphs so focused extraction remains useful for
 * plain-text and basic-extractor responses.
 */
function splitSections(markdown: string): Section[] {
  const blocks = markdown
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  if (blocks.length === 0) return [];

  const hasHeadings = blocks.some((block) => HEADING_PATTERN.test(block));
  if (!hasHeadings) return blocks.map((block) => ({ markdown: block, tokens: tokens(block) }));

  const sections: string[] = [];
  let current = "";
  for (const block of blocks) {
    if (HEADING_PATTERN.test(block) && current) {
      sections.push(current);
      current = block;
    } else {
      current = current ? `${current}\n\n${block}` : block;
    }
  }
  if (current) sections.push(current);
  return sections.map((section) => ({ markdown: section, tokens: tokens(section) }));
}

/**
 * Produces a deterministic, query-focused view of Markdown using a compact BM25-style
 * section ranker. Matching sections retain source order so the result remains readable
 * and attributable to the fetched page. The complete document is never mutated.
 */
export function focusMarkdown(markdown: string, query: string): FocusResult {
  const normalizedQuery = query.trim();
  const queryTerms = [...new Set(tokens(normalizedQuery))];
  const sections = splitSections(markdown);
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

  const focused = selected.map((section) => section.markdown).join("\n\n");
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
