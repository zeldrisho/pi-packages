/**
 * Rewrites GitHub source URLs to their raw counterparts so file contents are fetched as
 * clean plain text instead of Defuddle's noisy rendered view:
 *
 * - `github.com` `blob` URLs become their `raw.githubusercontent.com` counterpart.
 * - Bare gist pages (`gist.github.com/<user>/<id>`) get `/raw` appended; the redirect to
 *   `gist.githubusercontent.com` is followed by the normal redirect policy.
 *
 * @param rawUrl - The URL to normalize
 * @returns The rewritten raw URL, or the input unchanged for non-GitHub and non-source URLs
 */
export function normalizeGitHubRawUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);

    if (url.protocol !== "https:") return rawUrl;

    if (url.hostname === "github.com") {
      if (url.pathname.includes("/blob/")) {
        return `https://raw.githubusercontent.com${url.pathname.replace("/blob/", "/")}${url.search}`;
      }

      // Parse pathname segments: /owner/repo/tree/ref/path
      const segments = url.pathname.split("/").filter(Boolean);

      if (segments.length >= 4 && segments[2] === "tree") {
        const lastSegment = segments[segments.length - 1];

        if (lastSegment.includes(".")) {
          // Reconstruct path: /owner/repo/ref/path (remove "tree" segment)
          const newPath = `/${segments[0]}/${segments[1]}/${segments.slice(3).join("/")}`;

          return `https://raw.githubusercontent.com${newPath}${url.search}`;
        }

        return rawUrl;
      }

      return rawUrl;
    }

    if (url.hostname === "gist.github.com") {
      const segments = url.pathname.split("/").filter(Boolean);

      // Only rewrite bare gist pages. Subpages such as `/revisions`, `/forks`, or an
      // explicit `/raw` path already point at a usable resource and stay untouched.
      if (segments.length !== 2) return rawUrl;

      return `https://gist.github.com/${segments[0]}/${segments[1]}/raw${url.search}`;
    }

    return rawUrl;
  } catch {
    return rawUrl;
  }
}

/** Indexes GitHub-style Markdown heading slugs without treating fenced examples as headings. */
export function markdownFragmentOffsets(markdown: string) {
  const offsets: Record<string, number> = {};
  const duplicates = new Map<string, number>();
  const lines = markdown.split("\n");
  let offset = 0;
  let fence: { marker: string; length: number } | undefined;

  const addHeading = (text: string, headingOffset: number) => {
    let withoutHtml = "";

    for (let index = 0; index < text.length; index += 1) {
      if (text[index] !== "<") {
        withoutHtml += text[index];
        continue;
      }

      const tagEnd = text.indexOf(">", index + 1);

      if (tagEnd < 0) {
        withoutHtml += text.slice(index + 1);
        break;
      }

      index = tagEnd;
    }

    const base = withoutHtml
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[`*_~]/g, "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^\p{Letter}\p{Number} _-]/gu, "")
      .trim()
      .replace(/[ _]+/g, "-");

    if (!base) return;

    const duplicate = duplicates.get(base) ?? 0;
    duplicates.set(base, duplicate + 1);
    offsets[duplicate ? `${base}-${duplicate}` : base] = headingOffset;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);

    if (fenceMatch) {
      const marker = fenceMatch[1][0];

      if (!fence) fence = { marker, length: fenceMatch[1].length };
      else if (fence.marker === marker && fenceMatch[1].length >= fence.length) fence = undefined;
    } else if (!fence) {
      const atxHeading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
      const setextHeading = /^\s{0,3}(=+|-+)\s*$/.test(lines[index + 1] ?? "");

      if (atxHeading) addHeading(atxHeading[1], offset);
      else if (setextHeading) addHeading(line.trim(), offset);
    }

    offset += line.length + 1;
  }

  return offsets;
}

/** Indexes GitHub line anchors such as `#L78` in plain-text source files. */
export function lineFragmentOffsets(text: string) {
  const offsets: Record<string, number> = {};
  let offset = 0;

  for (const [index, line] of text.split("\n").entries()) {
    offsets[`L${index + 1}`] = offset;
    offset += line.length + 1;
  }

  return offsets;
}

/** Agent-discovery hints parsed from an HTTP `Link:` header. */
export interface LinkHeaderAgentHints {
  describedBy?: string;
  markdownAlternate?: string;
}

/**
 * Parses an HTTP `Link:` header for the agent-discovery link relations defined by
 * llmstxt.org v2: `rel="describedby"` (the covering `llms.txt`) and
 * `rel="alternate" type="text/markdown"` (the Markdown version of the resource).
 *
 * @param header - The raw `Link:` header value
 * @param baseUrl - URL used to resolve relative references
 * @returns The first advertised target of each relation, when present
 */
export function parseLinkHeaderForAgentHints(
  header: string,
  baseUrl: string | URL,
): LinkHeaderAgentHints {
  // Split on commas outside <...> and quoted strings, since URIs and quoted values may
  // themselves contain commas.
  const directives: string[] = [];
  let current = "";
  let inQuotes = false;
  let inAngleBrackets = false;

  for (const character of header) {
    if (character === '"') inQuotes = !inQuotes;

    if (character === "<") inAngleBrackets = true;

    if (character === ">" && !inQuotes) inAngleBrackets = false;

    if (character === "," && !inQuotes && !inAngleBrackets) {
      directives.push(current);
      current = "";
    } else {
      current += character;
    }
  }

  directives.push(current);

  let describedBy: string | undefined;
  let markdownAlternate: string | undefined;

  for (const directive of directives) {
    const match = /^\s*<([^>]*)>\s*(.*)$/.exec(directive);

    if (!match) continue;
    const [, rawTarget, rawParameters] = match;
    const parameters = new Map<string, string>();

    for (const parameter of rawParameters.split(";")) {
      const equals = parameter.indexOf("=");

      if (equals === -1) continue;
      const key = parameter.slice(0, equals).trim().toLowerCase();

      const value = parameter
        .slice(equals + 1)
        .trim()
        .replace(/^"|"$/g, "");

      parameters.set(key, value);
    }

    const relations = (parameters.get("rel") ?? "").toLowerCase().split(/\s+/);
    const type = (parameters.get("type") ?? "").toLowerCase();
    let resolved: string | undefined;

    try {
      resolved = new URL(rawTarget.trim(), baseUrl).href;
    } catch {
      continue;
    }

    if (!resolved) continue;

    if (!describedBy && relations.includes("describedby")) describedBy = resolved;

    if (!markdownAlternate && relations.includes("alternate") && type === "text/markdown") {
      markdownAlternate = resolved;
    }
  }

  return { describedBy, markdownAlternate };
}
