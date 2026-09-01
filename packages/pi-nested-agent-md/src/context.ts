import { basename, dirname, relative } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";

const MAX_FILE_BYTES = 32 * 1024;
const encoder = new TextEncoder();

interface ContentBlock {
  type: string;
  text?: string;
}

/**
 * Calculates the UTF-8 byte length of a string.
 *
 * @param value - String to measure
 * @returns Byte length of the UTF-8 encoded string
 */
function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

/**
 * Counts the number of lines in a string.
 *
 * @param value - String to count lines in
 * @returns Number of lines (newline-separated segments)
 */
function lineCount(value: string): number {
  if (value.length === 0) return 0;
  return value.split("\n").length;
}

/**
 * Truncates a string to fit within a UTF-8 byte limit without breaking characters.
 *
 * @param value - String to truncate
 * @param maxBytes - Maximum byte length
 * @returns Object with truncated text and truncation flag
 */
function truncateUtf8(value: string, maxBytes: number) {
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maxBytes) return { text: value, truncated: false };

  const decoder = new TextDecoder("utf-8");
  let text = decoder.decode(bytes.subarray(0, Math.max(0, maxBytes)));
  while (text.endsWith("\uFFFD")) text = text.slice(0, -1);
  return { text, truncated: true };
}

/**
 * Truncates a string to a maximum number of lines.
 *
 * @param value - String to truncate
 * @param maxLines - Maximum number of lines
 * @returns Object with truncated text and truncation flag
 */
function truncateLines(value: string, maxLines: number) {
  const lines = value.split("\n");
  if (lines.length <= maxLines) return { text: value, truncated: false };
  return { text: lines.slice(0, Math.max(0, maxLines)).join("\n"), truncated: true };
}

/**
 * Sanitizes a path string by replacing control characters with replacement character.
 *
 * @param value - Path string to sanitize
 * @returns Sanitized string with control characters replaced
 */
function safePathText(value: string): string {
  return value
    .split("")
    .map((character) => {
      const codeUnit = character.charCodeAt(0);
      return codeUnit <= 0x1f || (codeUnit >= 0x7f && codeUnit <= 0x9f) ? "\uFFFD" : character;
    })
    .join("");
}

/**
 * Escapes a string for safe use in XML attributes.
 *
 * @param value - String to escape
 * @returns XML-safe escaped string
 */
function escapeXmlAttribute(value: string): string {
  return safePathText(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Extracts and concatenates text content from content blocks.
 *
 * @param content - Array of content blocks
 * @returns Newline-joined text from all text blocks
 */
function originalText(content: readonly ContentBlock[]): string {
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

/**
 * Formats nested AGENTS.md content with XML tags and metadata.
 *
 * @param root - Repository root path
 * @param path - Path to the AGENTS.md file
 * @param content - File content to include
 * @param truncated - Whether content was truncated
 * @returns Formatted XML context block with file metadata
 */
function formatContext(root: string, path: string, content: string, truncated: boolean): string {
  const displayPath = safePathText(relative(root, path) || basename(path));
  const scope = safePathText(relative(root, dirname(path)) || ".");
  const note = truncated ? "\n[AGENTS.md truncated to fit Pi's tool-output limits.]" : "";
  return (
    `\n\n<nested_agents_context path="${escapeXmlAttribute(displayPath)}" scope="${escapeXmlAttribute(scope)}">\n` +
    `The following instructions apply to files under ${scope}/.\n\n${content}${note}\n</nested_agents_context>`
  );
}

/**
 * Formats a visible warning for a discovered instruction file whose contents
 * could not be read. Paths are control-character-sanitized and bounded so
 * untrusted file names cannot inject noise into model-visible output.
 */
export function formatReadWarning(root: string, path: string): string {
  const displayPath = safePathText(relative(root, path) || basename(path)).slice(0, 200);
  return `\n\n[nested-agents] Warning: nested instructions were found at ${displayPath}, but the file could not be read, so its instructions are NOT applied.`;
}

/**
 * Accumulates nested AGENTS.md content while respecting Pi's output limits.
 *
 * Tracks remaining byte and line capacity based on existing tool output and
 * allows appending instruction files until the limits are reached. Each file
 * is truncated if necessary to fit within the remaining capacity.
 */
export class ContextAccumulator {
  private bytesLeft: number;
  private linesLeft: number;
  private addition = "";

  constructor(content: readonly ContentBlock[]) {
    const existing = originalText(content);
    this.bytesLeft = Math.max(0, DEFAULT_MAX_BYTES - byteLength(existing));
    this.linesLeft = Math.max(0, DEFAULT_MAX_LINES - lineCount(existing));
  }

  /**
   * Gets the accumulated context text.
   *
   * @returns Accumulated context additions
   */
  get text(): string {
    return this.addition;
  }

  /**
   * Calculates remaining capacity for a file context block.
   *
   * @param root - Repository root path
   * @param path - File path
   * @returns Object with remaining bytes and lines capacity
   */
  private capacity(root: string, path: string) {
    const reservedWrapper = formatContext(root, path, "", true);
    return {
      bytes: Math.min(MAX_FILE_BYTES, this.bytesLeft - byteLength(reservedWrapper)),
      lines: this.linesLeft - lineCount(reservedWrapper) + 1,
    };
  }

  /**
   * Checks if there is remaining capacity for a file context block.
   *
   * @param root - Repository root path
   * @param path - File path
   * @returns True if capacity remains, false otherwise
   */
  hasCapacity(root: string, path: string): boolean {
    const capacity = this.capacity(root, path);
    return capacity.bytes > 0 && capacity.lines > 0;
  }

  /**
   * Appends a short diagnostic line when capacity remains.
   *
   * @param raw - Warning text to append
   * @returns True if the warning fit within remaining capacity, false otherwise
   */
  warn(raw: string): boolean {
    const section = raw;
    const sectionBytes = byteLength(section);
    const sectionLines = lineCount(section);
    if (sectionBytes > this.bytesLeft || sectionLines > this.linesLeft) return false;

    this.addition += section;
    this.bytesLeft -= sectionBytes;
    this.linesLeft -= sectionLines;
    return true;
  }

  /**
   * Appends a file's context, truncating if needed to fit within remaining capacity.
   *
   * @param root - Repository root path
   * @param path - File path
   * @param content - File content to append
   * @returns True if the content fit (possibly truncated), false if no capacity remains
   */
  append(root: string, path: string, content: string): boolean {
    const capacity = this.capacity(root, path);
    if (capacity.bytes <= 0 || capacity.lines <= 0) return false;

    const byteLimited = truncateUtf8(content, capacity.bytes);
    const lineLimited = truncateLines(byteLimited.text, capacity.lines);
    const section = formatContext(
      root,
      path,
      lineLimited.text,
      byteLimited.truncated || lineLimited.truncated,
    );
    const sectionBytes = byteLength(section);
    const sectionLines = lineCount(section);
    if (sectionBytes > this.bytesLeft || sectionLines > this.linesLeft) return false;

    this.addition += section;
    this.bytesLeft -= sectionBytes;
    this.linesLeft -= sectionLines;
    return true;
  }
}
