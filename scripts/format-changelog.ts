import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * Keep a Changelog 2.0.0 normalizer.
 *
 * Rewrites a package `CHANGELOG.md` so it follows the Keep a Changelog 2.0.0
 * conventions: a `# Changelog` header, the standard intro paragraph, an
 * `## [Unreleased]` section at the top, version headings of the form
 * `## [x.y.z] - YYYY-MM-DD` whose `[version]` text resolves to a comparison
 * link defined once at the bottom of the file, and the six standard change
 * types (`Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`).
 *
 * The function is pure: it takes raw changelog text and returns normalized text.
 */

const KEEP_A_CHANGELOG_INTRO = `All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).`;

const STANDARD_SECTIONS = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"];

/**
 * Maps a heading title to its Keep a Changelog 2.0.0 equivalent. Titles already
 * in the standard set pass through; common non-standard titles are folded into
 * the closest standard type; anything else is preserved verbatim (so bespoke
 * categories survive a normalization pass).
 */
const SECTION_TITLE_MAP: Record<string, string> = {
  Features: "Added",
  Feature: "Added",
  "Bug Fixes": "Fixed",
  "Bug fixes": "Fixed",
  "Bug Fix": "Fixed",
  "Performance Improvements": "Changed",
  "Performance improvements": "Changed",
  Performance: "Changed",
  Reverts: "Changed",
  Revert: "Changed",
  Chores: "Changed",
  Chore: "Changed",
  Maintenance: "Changed",
  Housekeeping: "Changed",
  Internal: "Changed",
  Miscellaneous: "Changed",
  Documentation: "Changed",
  Docs: "Changed",
  "Code Refactoring": "Changed",
  Refactor: "Changed",
  Refactoring: "Changed",
  Added: "Added",
  Changed: "Changed",
  Deprecated: "Deprecated",
  Removed: "Removed",
  Fixed: "Fixed",
  Security: "Security",
};

interface ChangeEntry {
  version: string;
  date: string | null;
  preamble: string[];
  sections: Array<{ title: string; lines: string[] }>;
}

function normalizeSectionTitle(title: string): string {
  return SECTION_TITLE_MAP[title.trim()] ?? title.trim();
}

function compareSemver(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  }
  return 0;
}

function parseHeading(line: string): { version: string; date: string | null } {
  const bracket = line.match(/^##\s+\[([^\]]+)\]/);
  const raw = bracket ? bracket[1].trim() : line.replace(/^##\s+/, "").trim();
  // Some legacy headings pack the date inside the bracket, e.g. `[0.2.0 (2026-07-19)]`.
  const semverMatch = raw.match(/^(\d+\.\d+\.\d+)/);
  const version = semverMatch ? semverMatch[1] : raw;
  const dateMatch = line.match(/(\d{4}-\d{2}-\d{2})/);
  return { version, date: dateMatch ? dateMatch[1] : null };
}

function parseEntry(segment: string[]): ChangeEntry {
  const heading = parseHeading(segment[0] ?? "## [Unreleased]");
  const preamble: string[] = [];
  const sections: Array<{ title: string; lines: string[] }> = [];
  let current: { title: string; lines: string[] } | null = null;
  for (const line of segment.slice(1)) {
    const sectionMatch = line.match(/^###\s+(.*)$/);
    if (sectionMatch) {
      current = { title: sectionMatch[1].trim(), lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  // Drop the blank separator line that follows each `###` heading so merged
  // sections stay contiguous and re-emit with a single blank between sections.
  for (const section of sections) {
    while (section.lines.length > 0 && section.lines[0].trim() === "") section.lines.shift();
    while (section.lines.length > 0 && section.lines[section.lines.length - 1].trim() === "")
      section.lines.pop();
  }
  return { version: heading.version, date: heading.date, preamble, sections };
}

function orderIndex(title: string): number {
  const index = STANDARD_SECTIONS.indexOf(title);
  return index === -1 ? STANDARD_SECTIONS.length : index;
}

function renderEntry(entry: ChangeEntry): string {
  const title = entry.version === "Unreleased" ? "Unreleased" : entry.version;
  const heading = entry.date ? `## [${title}] - ${entry.date}` : `## [${title}]`;
  const parts: string[] = [];
  const preamble = entry.preamble.join("\n").trim();
  if (preamble) parts.push(preamble);
  const merged = new Map<string, string[]>();
  for (const section of entry.sections) {
    const normalized = normalizeSectionTitle(section.title);
    const lines = (merged.get(normalized) ?? []).concat(section.lines);
    merged.set(normalized, lines);
  }
  const ordered = [...merged.entries()].sort(
    (left, right) => orderIndex(left[0]) - orderIndex(right[0]),
  );
  for (const [sectionTitle, lines] of ordered) {
    // Keep a Changelog lists bullets contiguously; drop the blank separators
    // the legacy generator left between items.
    const body = lines.filter((line) => line.trim() !== "").join("\n");
    parts.push(body ? `### ${sectionTitle}\n${body}` : `### ${sectionTitle}`);
  }
  if (parts.length === 0) return heading;
  return `${heading}\n\n${parts.join("\n\n")}`;
}

/**
 * Normalizes a package changelog to Keep a Changelog 2.0.0.
 *
 * @param content - Raw `CHANGELOG.md` text (must begin with a `# Changelog` header)
 * @param options.repoUrl - Canonical repository URL, e.g. `https://github.com/owner/repo`
 * @param options.packageDirectory - Package directory name used to build component tags
 * @returns Normalized `CHANGELOG.md` text
 */
export function formatChangelog(
  content: string,
  options: { repoUrl: string; packageDirectory: string },
): string {
  const lines = content.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => /^#\s/.test(line));
  if (headerIndex === -1) {
    throw new Error("Changelog must begin with a '# Changelog' header");
  }
  const firstEntryIndex = lines.findIndex(
    (line, index) => index > headerIndex && /^##\s/.test(line),
  );

  const entries: ChangeEntry[] = [];
  const start = firstEntryIndex === -1 ? lines.length : firstEntryIndex;
  let segment: string[] = [];
  const flush = () => {
    if (segment.length > 0) entries.push(parseEntry(segment));
  };
  for (const line of lines.slice(start)) {
    if (/^##\s/.test(line)) {
      flush();
      segment = [line];
    } else if (/^\[[^\]]+\]:\s*\S/.test(line)) {
      // Trailing link references are rebuilt deterministically from the version
      // list below, so drop any pre-existing ones from the parsed body.
    } else {
      segment.push(line);
    }
  }
  flush();

  const unreleased = entries.find((entry) => entry.version === "Unreleased");
  const versions = entries
    .filter((entry) => entry.version !== "Unreleased")
    .sort((left, right) => compareSemver(right.version, left.version));

  const { repoUrl, packageDirectory } = options;
  const tagFor = (version: string) => `${packageDirectory}-v${version}`;
  const refs: string[] = [];
  for (let i = 0; i < versions.length; i += 1) {
    const version = versions[i].version;
    const tag = tagFor(version);
    if (i === versions.length - 1) {
      refs.push(`[${version}]: ${repoUrl}/releases/tag/${tag}`);
    } else {
      const previousTag = tagFor(versions[i + 1].version);
      refs.push(`[${version}]: ${repoUrl}/compare/${previousTag}...${tag}`);
    }
  }
  if (versions.length > 0) {
    refs.unshift(`[Unreleased]: ${repoUrl}/compare/${tagFor(versions[0].version)}...HEAD`);
  }

  // Preserve a manually written Unreleased body only when it carries content.
  const unreleasedHasContent =
    unreleased && (unreleased.preamble.join("").trim() !== "" || unreleased.sections.length > 0);
  const unreleasedBlock = renderEntry({
    version: "Unreleased",
    date: null,
    preamble: unreleasedHasContent ? unreleased!.preamble : [],
    sections: unreleasedHasContent ? unreleased!.sections : [],
  });

  const blocks = [unreleasedBlock, ...versions.map(renderEntry)];

  return `# Changelog\n\n${KEEP_A_CHANGELOG_INTRO}\n\n${blocks.join("\n\n")}\n\n${refs.join("\n")}\n`;
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dirname, "..");
  const repository = process.env.GITHUB_REPOSITORY ?? "zeldrisho/pi-packages";
  const repoUrl = `https://github.com/${repository}`;
  const packagesRoot = join(root, "packages");
  const directories = (await readdir(packagesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const directory of directories) {
    const path = join(packagesRoot, directory, "CHANGELOG.md");
    const original = await readFile(path, "utf8");
    const normalized = formatChangelog(original, { repoUrl, packageDirectory: directory });
    if (normalized !== original) {
      await writeFile(path, normalized);
      process.stdout.write(`Formatted ${path}\n`);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
