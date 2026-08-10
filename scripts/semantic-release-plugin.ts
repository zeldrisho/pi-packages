import { execFileSync } from "node:child_process";

interface PluginConfig {
  packagePath: string;
  repository: string;
}

interface SemanticCommit {
  hash: string;
  subject: string;
  body?: string;
}

interface ReleaseContext {
  cwd: string;
  commits: SemanticCommit[];
  lastRelease: { gitTag?: string };
  nextRelease: { version: string; gitTag: string };
}

type ReleaseType = "major" | "minor" | "patch";

const groups = new Map([
  ["feat", "Features"],
  ["fix", "Bug fixes"],
  ["perf", "Performance"],
  ["revert", "Reverts"],
  ["doc", "Documentation"],
  ["docs", "Documentation"],
  ["refactor", "Refactoring"],
  ["test", "Tests"],
  ["build", "Build system"],
  ["ci", "Continuous integration"],
  ["chore", "Maintenance"],
]);

interface ParsedCommit extends SemanticCommit {
  description: string;
  group: string;
  scope?: string;
  type: string;
  breaking: boolean;
}

function parseCommit(commit: SemanticCommit): ParsedCommit | undefined {
  const match =
    /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?(?<breaking>!)?:\s+(?<description>.+)$/i.exec(
      commit.subject,
    );
  if (!match?.groups) return undefined;
  const type = match.groups.type.toLowerCase();
  if (type === "style" || (type === "chore" && match.groups.description === "release packages")) {
    return undefined;
  }
  // Compute breaking flag before checking groups, so breaking commits with unlisted types
  // are still detected for major version bumps
  const breaking = match.groups.breaking === "!" || /^BREAKING[ -]CHANGE:/m.test(commit.body ?? "");
  const group = groups.get(type);
  if (!group) {
    // Return breaking commits even if their type isn't listed, so analyzeCommits can detect them
    if (!breaking) return undefined;
    // Use a generic group name for breaking commits with unlisted types
    return {
      ...commit,
      type,
      scope: match.groups.scope,
      description: match.groups.description,
      breaking,
      group: "Other changes",
    };
  }
  return {
    ...commit,
    type,
    scope: match.groups.scope,
    description: match.groups.description,
    breaking,
    group,
  };
}

function packageCommits(config: PluginConfig, context: ReleaseContext): ParsedCommit[] {
  if (!/^packages\/[A-Za-z0-9._-]+$/.test(config.packagePath)) {
    throw new Error(`Invalid semantic-release packagePath: ${config.packagePath}`);
  }
  const range = context.lastRelease.gitTag ? `${context.lastRelease.gitTag}..HEAD` : "HEAD";
  const output = execFileSync("git", ["log", range, "--format=%H", "--", config.packagePath], {
    cwd: context.cwd,
    encoding: "utf8",
  });
  const included = new Set(output.trim().split("\n").filter(Boolean));
  return context.commits
    .filter((commit) => included.has(commit.hash))
    .map(parseCommit)
    .filter((commit): commit is ParsedCommit => commit !== undefined);
}

/** Determine a package-local release type using the repository's conventional-commit policy. */
export async function analyzeCommits(
  config: PluginConfig,
  context: ReleaseContext,
): Promise<ReleaseType | undefined> {
  let release: ReleaseType | undefined;
  for (const commit of packageCommits(config, context)) {
    if (commit.breaking) return "major";
    if (commit.type === "feat") release = release === "patch" || !release ? "minor" : release;
    else if (["fix", "perf", "revert"].includes(commit.type) && !release) release = "patch";
  }
  return release;
}

function upperFirst(value: string): string {
  return value.length === 0 ? value : `${value[0].toUpperCase()}${value.slice(1)}`;
}

/** Render package-local Markdown release notes. */
export async function generateNotes(
  config: PluginConfig,
  context: ReleaseContext,
): Promise<string> {
  const commits = packageCommits(config, context);
  const previousTag = context.lastRelease.gitTag;
  const version = context.nextRelease.version;
  const heading = previousTag
    ? `## [${version}](https://github.com/${config.repository}/compare/${previousTag}...${context.nextRelease.gitTag}) (${new Date().toISOString().slice(0, 10)})`
    : `## ${version} (${new Date().toISOString().slice(0, 10)})`;
  const sections: string[] = [heading];
  for (const group of new Set(commits.map((commit) => commit.group))) {
    const entries = commits
      .filter((commit) => commit.group === group)
      .reverse()
      .map((commit) => {
        const scope = commit.scope ? `**${commit.scope}:** ` : "";
        const shortHash = commit.hash.slice(0, 7);
        return `- ${scope}${upperFirst(commit.description)} ([${shortHash}](https://github.com/${config.repository}/commit/${commit.hash}))`;
      });
    sections.push(`### ${group}\n\n${entries.join("\n")}`);
  }
  return `${sections.join("\n\n")}\n`;
}
