import type { CompleteDocument } from "./content";

/** Removes a URL fragment before acquisition so fragment variants share cache entries. */
export function urlWithoutFragment(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.hash = "";

    return url.href;
  } catch {
    return rawUrl;
  }
}

interface ResolvedFragment {
  fragment?: string;
  offset?: number;
  endOffset?: number;
}

/** Converts a one-based source line and column into a Markdown character offset. */
function sourceOffset(markdown: string, lineNumber: number, columnNumber = 1): number | undefined {
  if (lineNumber < 1 || columnNumber < 1) return undefined;

  const lines = markdown.split("\n");

  if (lineNumber > lines.length) return undefined;

  let offset = 0;

  for (let index = 0; index < lineNumber - 1; index += 1) offset += lines[index].length + 1;

  return offset + Math.min(columnNumber - 1, lines[lineNumber - 1].length);
}

/** Resolves heading and source-location URL fragments against a fetched document. */
export function resolveFragmentOffset(
  document: CompleteDocument,
  rawUrl: string,
): ResolvedFragment {
  let fragment: string | undefined;

  try {
    const hash = new URL(rawUrl).hash;

    if (hash) fragment = decodeURIComponent(hash.slice(1));
  } catch {
    return {};
  }

  if (!fragment) return {};

  const lineAnchor = /^L(\d+)(?:C(\d+))?(?:-L?(\d+)(?:C(\d+))?)?$/i.exec(fragment);

  if (lineAnchor) {
    const [, firstLine, firstColumn, lastLine, lastColumn] = lineAnchor;
    const offset = sourceOffset(document.markdown, Number(firstLine), Number(firstColumn ?? 1));

    if (offset === undefined) return { fragment };

    if (lastLine) {
      const endLine = Number(lastLine);
      const endColumn = lastColumn === undefined ? undefined : Number(lastColumn);
      const lines = document.markdown.split("\n");
      const line = lines[endLine - 1];

      if (line === undefined) return { fragment };

      const endOffset =
        endColumn === undefined
          ? sourceOffset(document.markdown, endLine, line.length + 1)
          : sourceOffset(document.markdown, endLine, endColumn + 1);

      return endOffset !== undefined && endOffset >= offset
        ? { fragment, offset, endOffset }
        : { fragment };
    }

    return { fragment, offset };
  }

  const offsets = document.fragmentOffsets ?? {};

  return { fragment, offset: offsets[fragment] ?? offsets[fragment.toLowerCase()] };
}
