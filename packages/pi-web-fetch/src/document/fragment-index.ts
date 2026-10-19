function stripMarkupForFragmentSlug(value: string): string {
  let result = "";

  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "<") {
      result += value[index];
      continue;
    }

    const tagEnd = value.indexOf(">", index + 1);

    if (tagEnd < 0) {
      // Preserve the old behavior for an unterminated tag: only discard `<`.
      result += value.slice(index + 1);
      break;
    }

    index = tagEnd;
  }

  return result;
}

function fragmentSlug(value: string): string {
  return stripMarkupForFragmentSlug(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number} _-]/gu, "")
    .trim()
    .replace(/[ _]+/g, "-");
}

/** Finds the extracted Markdown position corresponding to HTML fragment IDs. */
interface FragmentOffsets {
  [fragment: string]: number;
}

export function buildFragmentOffsets(
  document: Document,
  markdown: string,
  originalIds?: ReadonlyMap<HTMLElement, string>,
): FragmentOffsets {
  const lines = markdown.split("\n");

  const headings = lines
    .map((line, index) => {
      const match = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);

      return match
        ? {
            slug: fragmentSlug(match[1]),
            offset: lines.slice(0, index).join("\n").length + (index ? 1 : 0),
          }
        : undefined;
    })
    .filter((heading): heading is { slug: string; offset: number } => Boolean(heading));

  const offsets: Record<string, number> = {};
  const used = new Set<number>();

  for (const element of document.querySelectorAll<HTMLElement>("[id], a[name]")) {
    const id =
      originalIds?.get(element) ?? element.getAttribute("id") ?? element.getAttribute("name");

    if (!id) continue;
    const slug = fragmentSlug(id);
    const textSlug = fragmentSlug(element.textContent ?? "");

    const heading = headings.find(
      (candidate) =>
        candidate.slug === slug ||
        (textSlug && candidate.slug === textSlug && !used.has(candidate.offset)),
    );

    if (heading) {
      offsets[id] = heading.offset;
      used.add(heading.offset);
    } else {
      const text = (element.textContent ?? "").trim();

      if (text) {
        const textOffset = markdown.toLowerCase().indexOf(text.toLowerCase());

        if (textOffset >= 0) offsets[id] = textOffset;
      }
    }
  }

  // Most Markdown producers preserve headings but discard arbitrary HTML IDs.
  // Resolve GitHub-style heading links even when no matching HTML ID survived.
  for (const heading of headings) {
    const base = heading.slug;

    if (base && offsets[base] === undefined) offsets[base] = heading.offset;
  }

  return offsets;
}
