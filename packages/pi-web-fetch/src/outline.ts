const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;
const MAX_FALLBACK_HEADING_CHARACTERS = 60;
export const MAX_OUTLINE_HEADINGS = 12;
export const MAX_OUTLINE_HEADING_CHARACTERS = 120;

/** One bounded heading exposed as untrusted document-shape metadata. */
export interface OutlineHeading {
  level: number;
  text: string;
  words: number;
  inferred: boolean;
}

/** Bounded structural summary of a complete extracted document. */
export interface DocumentOutline {
  totalWords: number;
  totalHeadings: number;
  headings: OutlineHeading[];
  omittedHeadings: number;
}

interface HeadingLocation {
  level: number;
  text: string;
  line: number;
  inferred: boolean;
}

interface HeadingCollection {
  locations: HeadingLocation[];
  total: number;
}

interface ParsedAtxHeading {
  level: number;
  text: string;
}

interface MarkdownFence {
  character: string;
  length: number;
}

function updateFence(line: string, fence: MarkdownFence | undefined): MarkdownFence | undefined {
  const match = FENCE.exec(line);
  if (!match) return fence;
  const marker = match[1];
  if (!fence) return { character: marker[0], length: marker.length };
  const closes =
    marker[0] === fence.character &&
    marker.length >= fence.length &&
    !line.slice(match[0].length).trim();
  return closes ? undefined : fence;
}

/**
 * Checks if a character is a space or tab.
 *
 * @param character - The character to check
 * @returns `true` if the character is a space or tab
 */
function isSpaceOrTab(character: string | undefined): boolean {
  return character === " " || character === "\t";
}

/** Parses the bounded ATX prefix with a linear scan to avoid backtracking on remote input. */
function parseAtxHeading(line: string): ParsedAtxHeading | undefined {
  let index = 0;
  while (index < 3 && isSpaceOrTab(line[index])) index += 1;
  if (isSpaceOrTab(line[index])) return undefined;

  const markerStart = index;
  while (line[index] === "#") index += 1;
  const level = index - markerStart;
  if (level < 1 || level > 6 || !isSpaceOrTab(line[index])) return undefined;

  while (isSpaceOrTab(line[index])) index += 1;
  return { level, text: line.slice(index) };
}

/**
 * Counts the number of whitespace-separated words in a string.
 *
 * @param value - The string to count words in
 * @returns The number of words, or 0 if the string is empty after trimming
 */
function countWords(value: string): number {
  const trimmed = value.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/**
 * Counts the total words in a document while respecting fenced code blocks.
 *
 * @param lines - The document lines to count words in
 * @returns The total word count across all lines, including fenced content
 */
function countDocumentWords(lines: string[]): number {
  let fence: MarkdownFence | undefined;
  return lines.reduce((total, line) => {
    const wasInsideFence = Boolean(fence);
    fence = updateFence(line, fence);
    const heading = wasInsideFence || fence ? undefined : parseAtxHeading(line);
    return total + countWords(heading ? cleanHeading(heading.text) : line);
  }, 0);
}

/**
 * Removes trailing whitespace and optional closing markers from heading text, then bounds the result.
 *
 * @param value - The raw heading text to clean
 * @returns The cleaned and bounded heading text
 */
function cleanHeading(value: string): string {
  let contentEnd = value.length;
  while (contentEnd > 0 && isSpaceOrTab(value[contentEnd - 1])) contentEnd -= 1;

  let markerStart = contentEnd;
  while (markerStart > 0 && value[markerStart - 1] === "#") markerStart -= 1;
  if (markerStart < contentEnd && markerStart > 0 && isSpaceOrTab(value[markerStart - 1])) {
    contentEnd = markerStart - 1;
    while (contentEnd > 0 && isSpaceOrTab(value[contentEnd - 1])) contentEnd -= 1;
  }

  return value.slice(0, contentEnd).trim().slice(0, MAX_OUTLINE_HEADING_CHARACTERS);
}

/**
 * Collects ATX headings from Markdown lines while respecting fenced code blocks.
 *
 * @param lines - The document lines to scan for ATX headings
 * @returns Collection of heading locations and total heading count
 */
function collectAtxHeadings(lines: string[]): HeadingCollection {
  const locations: HeadingLocation[] = [];
  let total = 0;
  let fence: MarkdownFence | undefined;

  for (const [lineNumber, line] of lines.entries()) {
    const wasInsideFence = Boolean(fence);
    fence = updateFence(line, fence);
    if (wasInsideFence || fence) continue;
    const heading = parseAtxHeading(line);
    if (!heading) continue;
    const text = cleanHeading(heading.text);
    if (!text) continue;
    total += 1;
    if (locations.length <= MAX_OUTLINE_HEADINGS) {
      locations.push({ level: heading.level, text, line: lineNumber, inferred: false });
    }
  }
  return { locations, total };
}

/**
 * Heuristically determines if a line looks like a heading when ATX headings are unavailable.
 *
 * @param line - The current line to evaluate
 * @param nextLine - The following non-empty line for context
 * @returns `true` if the line appears to be a heading
 */
function looksLikeFallbackHeading(line: string, nextLine: string): boolean {
  if (/^\s{4,}/.test(line)) return false;
  const candidate = line.trim();
  if (
    !candidate ||
    candidate.length > MAX_FALLBACK_HEADING_CHARACTERS ||
    !/[A-Za-z]/.test(candidate) ||
    /[.!?…,;:]$/.test(candidate) ||
    /[,;]/.test(candidate) ||
    /^([-*+]|\d+\.)\s/.test(candidate) ||
    /^(>|\||https?:\/\/)/i.test(candidate)
  ) {
    return false;
  }
  if (!/^[A-Z]/.test(candidate) && !/[`()._]/.test(candidate)) return false;
  const following = nextLine.trim();
  return following.length > MAX_FALLBACK_HEADING_CHARACTERS || /[.!?]$/.test(following);
}

/**
 * Collects inferred headings using heuristics when no ATX headings are present.
 *
 * @param lines - The document lines to scan for heading-like content
 * @returns Collection of inferred heading locations and total count
 */
function collectFallbackHeadings(lines: string[]): HeadingCollection {
  const locations: HeadingLocation[] = [];
  let total = 0;
  const nextNonEmptyIndexes = new Int32Array(lines.length);
  nextNonEmptyIndexes.fill(-1);
  let nextNonEmptyIndex = -1;
  for (let lineNumber = lines.length - 1; lineNumber >= 0; lineNumber -= 1) {
    nextNonEmptyIndexes[lineNumber] = nextNonEmptyIndex;
    if (lines[lineNumber].trim()) nextNonEmptyIndex = lineNumber;
  }
  let fence: MarkdownFence | undefined;

  for (const [lineNumber, line] of lines.entries()) {
    const wasInsideFence = Boolean(fence);
    fence = updateFence(line, fence);
    if (wasInsideFence || fence) continue;
    const followingIndex = nextNonEmptyIndexes[lineNumber];
    const following = followingIndex === -1 ? "" : lines[followingIndex];
    if (looksLikeFallbackHeading(line, following)) {
      total += 1;
      if (locations.length <= MAX_OUTLINE_HEADINGS) {
        locations.push({ level: 2, text: cleanHeading(line), line: lineNumber, inferred: true });
      }
    }
  }
  return { locations, total };
}

/**
 * Builds a bounded, fence-aware outline from complete extracted Markdown.
 *
 * ATX headings are preferred. Only documents with no ATX headings use conservative plain-text
 * heading inference. Heading text is remote, untrusted metadata and is bounded before exposure.
 */
export function createDocumentOutline(markdown: string): DocumentOutline {
  const lines = markdown.split("\n");
  const explicit = collectAtxHeadings(lines);
  const collection = explicit.total > 0 ? explicit : collectFallbackHeadings(lines);
  const headings = collection.locations.slice(0, MAX_OUTLINE_HEADINGS).map((heading, index) => {
    const next = collection.locations[index + 1]?.line ?? lines.length;
    return {
      level: heading.level,
      text: heading.text,
      words: countWords(lines.slice(heading.line + 1, next).join("\n")),
      inferred: heading.inferred,
    };
  });
  return {
    totalWords: countDocumentWords(lines),
    totalHeadings: collection.total,
    headings,
    omittedHeadings: Math.max(0, collection.total - headings.length),
  };
}
