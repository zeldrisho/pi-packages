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

function countWords(value: string): number {
  const trimmed = value.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function countDocumentWords(lines: string[]): number {
  let fenceCharacter: string | undefined;
  return lines.reduce((total, line) => {
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      const character = fenceMatch[1][0];
      if (!fenceCharacter) fenceCharacter = character;
      else if (fenceCharacter === character) fenceCharacter = undefined;
      return total + countWords(line);
    }
    const heading = fenceCharacter ? undefined : parseAtxHeading(line);
    return total + countWords(heading ? cleanHeading(heading.text) : line);
  }, 0);
}

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

function collectAtxHeadings(lines: string[]): HeadingCollection {
  const locations: HeadingLocation[] = [];
  let total = 0;
  let fenceCharacter: string | undefined;

  for (const [lineNumber, line] of lines.entries()) {
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      const character = fenceMatch[1][0];
      if (!fenceCharacter) fenceCharacter = character;
      else if (fenceCharacter === character) fenceCharacter = undefined;
      continue;
    }
    if (fenceCharacter) continue;
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
  let fenceCharacter: string | undefined;

  for (const [lineNumber, line] of lines.entries()) {
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      const character = fenceMatch[1][0];
      if (!fenceCharacter) fenceCharacter = character;
      else if (fenceCharacter === character) fenceCharacter = undefined;
      continue;
    }
    if (fenceCharacter) continue;
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
