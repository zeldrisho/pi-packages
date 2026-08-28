import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";

const CONTENT_LINE_BUDGET = Math.max(1, DEFAULT_MAX_LINES - 10);
const CONTENT_BYTE_BUDGET = Math.max(1_024, DEFAULT_MAX_BYTES - 2_048);
const encoder = new TextEncoder();

/**
 * A complete fetched document with extracted content and metadata.
 *
 * Contains the full markdown representation along with metadata about
 * the extraction method and any special handling that was applied.
 */
export interface CompleteDocument {
  url: string;
  contentType: string;
  markdown: string;
  title?: string;
  extractor: "defuddle" | "basic" | "raw";
  /** True when the page appears to be an app shell, bot wall, or consent page. */
  shellSuspected: boolean;
  /** True when this document is the site's /llms.txt served instead of a low-quality page. */
  llmsTxtFallback?: boolean;
  /** Set when the site publishes a usable /llms.txt index and this document is not that index. */
  llmsTxtIndexUrl?: string;
  /** Absolute URL advertised via `rel="describedby"` (header or HTML link) for this page. */
  llmsTxtDescribedBy?: string;
  /** Absolute URL advertised for a Markdown version of this page (`rel="alternate" type="text/markdown"`). */
  markdownAlternateUrl?: string;
  /** True when this document is the advertised Markdown version served instead of a low-quality page. */
  markdownAlternateFallback?: boolean;
}

/**
 * A paginated chunk of fetched content with offset tracking.
 *
 * Extends CompleteDocument with pagination metadata to support
 * reading large documents in bounded chunks.
 */
export interface FetchResult extends CompleteDocument {
  offset: number;
  nextOffset?: number;
  totalCharacters: number;
  truncated: boolean;
}

function sliceByByteLength(value: string, maxBytes: number): string {
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encoder.encode(value.slice(0, middle)).byteLength <= maxBytes) low = middle;
    else high = middle - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/.test(value[low - 1])) low -= 1;
  return value.slice(0, low);
}

function boundedContentChunk(value: string, offset: number, maxCharacters: number): string {
  let chunk = value.slice(offset, offset + maxCharacters);
  let newline = -1;
  for (let lines = 1; lines < CONTENT_LINE_BUDGET; lines += 1) {
    newline = chunk.indexOf("\n", newline + 1);
    if (newline === -1) break;
  }
  if (newline !== -1) chunk = chunk.slice(0, newline);
  return sliceByByteLength(chunk, CONTENT_BYTE_BUDGET);
}

/**
 * Slice a complete document into a bounded content chunk.
 *
 * Extracts a chunk of content starting at the given offset, respecting
 * character, line, and byte limits. Adds pagination metadata and
 * continuation instructions when content is truncated.
 *
 * @param document - Complete document to slice
 * @param offset - Character offset to start reading from
 * @param maxCharacters - Maximum characters to include in the chunk
 * @returns Paginated fetch result with content chunk and metadata
 */
export function sliceCompleteDocument(
  document: CompleteDocument,
  offset: number,
  maxCharacters: number,
): FetchResult {
  const totalCharacters = document.markdown.length;
  let markdown = boundedContentChunk(document.markdown, offset, maxCharacters);
  const end = offset + markdown.length;
  const truncated = end < totalCharacters;
  if (truncated) {
    markdown += `\n\n[Content truncated. Continue with offset=${end} to read the next chunk.]`;
  } else if (offset > 0) {
    markdown += "\n\n[End of page content.]";
  }
  return {
    ...document,
    markdown,
    offset,
    nextOffset: truncated ? end : undefined,
    totalCharacters,
    truncated,
  };
}
