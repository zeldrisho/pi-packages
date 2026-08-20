import { basename, dirname, relative } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";

const MAX_FILE_BYTES = 32 * 1024;
const encoder = new TextEncoder();

interface ContentBlock {
  type: string;
  text?: string;
}

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function lineCount(value: string): number {
  if (value.length === 0) return 0;
  return value.split("\n").length;
}

function truncateUtf8(value: string, maxBytes: number) {
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maxBytes) return { text: value, truncated: false };

  const decoder = new TextDecoder("utf-8");
  let text = decoder.decode(bytes.subarray(0, Math.max(0, maxBytes)));
  while (text.endsWith("\uFFFD")) text = text.slice(0, -1);
  return { text, truncated: true };
}

function truncateLines(value: string, maxLines: number) {
  const lines = value.split("\n");
  if (lines.length <= maxLines) return { text: value, truncated: false };
  return { text: lines.slice(0, Math.max(0, maxLines)).join("\n"), truncated: true };
}

function safePathText(value: string): string {
  return value
    .split("")
    .map((character) => {
      const codeUnit = character.charCodeAt(0);
      return codeUnit <= 0x1f || (codeUnit >= 0x7f && codeUnit <= 0x9f) ? "\uFFFD" : character;
    })
    .join("");
}

function escapeXmlAttribute(value: string): string {
  return safePathText(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function originalText(content: readonly ContentBlock[]): string {
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

function formatContext(root: string, path: string, content: string, truncated: boolean): string {
  const displayPath = safePathText(relative(root, path) || basename(path));
  const scope = safePathText(relative(root, dirname(path)) || ".");
  const note = truncated ? "\n[AGENTS.md truncated to fit Pi's tool-output limits.]" : "";
  return (
    `\n\n<nested_agents_context path="${escapeXmlAttribute(displayPath)}" scope="${escapeXmlAttribute(scope)}">\n` +
    `The following instructions apply to files under ${scope}/.\n\n${content}${note}\n</nested_agents_context>`
  );
}

export class ContextAccumulator {
  private bytesLeft: number;
  private linesLeft: number;
  private addition = "";

  constructor(content: readonly ContentBlock[]) {
    const existing = originalText(content);
    this.bytesLeft = Math.max(0, DEFAULT_MAX_BYTES - byteLength(existing));
    this.linesLeft = Math.max(0, DEFAULT_MAX_LINES - lineCount(existing));
  }

  get text(): string {
    return this.addition;
  }

  private capacity(root: string, path: string) {
    const reservedWrapper = formatContext(root, path, "", true);
    return {
      bytes: Math.min(MAX_FILE_BYTES, this.bytesLeft - byteLength(reservedWrapper)),
      lines: this.linesLeft - lineCount(reservedWrapper) + 1,
    };
  }

  hasCapacity(root: string, path: string): boolean {
    const capacity = this.capacity(root, path);
    return capacity.bytes > 0 && capacity.lines > 0;
  }

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
