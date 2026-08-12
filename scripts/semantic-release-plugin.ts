import { execFileSync } from "node:child_process";
import { analyzeCommits as analyzeWithConventionalcommits } from "@semantic-release/commit-analyzer";
import { generateNotes as generateWithConventionalcommits } from "@semantic-release/release-notes-generator";

/**
 * Release policy for one independently versioned package.
 *
 * Commit analysis and release notes are delegated to the official
 * `@semantic-release/commit-analyzer` and `@semantic-release/release-notes-generator`
 * plugins with the `conventionalcommits` preset. This wrapper only restricts those
 * plugins to the commits that touched the package, because semantic-release core
 * analyzes the whole repository range.
 *
 * The `conventionalcommits` preset enforces the repository's version policy:
 * breaking changes are `major`, `feat` is `minor`, and `fix`, `perf`, or `revert`
 * is `patch`; other conventional types (docs, refactor, test, build, ci, chore,
 * style, ...) never trigger a release on their own but still appear in release
 * notes when bundled with a release. It also renders the `## [version](compare)
 * (date)` changelog headings and grouped sections used in this repository.
 */

interface PluginConfig {
  packagePath: string;
  /** Canonical `owner/repository` used to render compare and commit links. */
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
  options: { repositoryUrl: string };
}

/**
 * Builds the context handed to the official plugins: package-local commits and a
 * canonical repository URL for link rendering. The URL is injected only here so
 * semantic-release keeps authenticating and verifying pushes against the actual
 * git origin (see `getGitAuthUrl`), which would fail against a hardcoded URL in
 * sandboxed or branch-protected environments.
 */
function pluginContext(config: PluginConfig, context: ReleaseContext): ReleaseContext {
  return {
    ...context,
    commits: packageCommits(config, context),
    options: {
      ...context.options,
      repositoryUrl: `https://github.com/${config.repository}.git`,
    },
  };
}

function packageCommits(config: PluginConfig, context: ReleaseContext): SemanticCommit[] {
  if (!/^packages\/[A-Za-z0-9._-]+$/.test(config.packagePath)) {
    throw new Error(`Invalid semantic-release packagePath: ${config.packagePath}`);
  }
  const range = context.lastRelease.gitTag ? `${context.lastRelease.gitTag}..HEAD` : "HEAD";
  const output = execFileSync("git", ["log", range, "--format=%H", "--", config.packagePath], {
    cwd: context.cwd,
    encoding: "utf8",
  });
  const included = new Set(output.trim().split("\n").filter(Boolean));
  return context.commits.filter((commit) => included.has(commit.hash));
}

/** Analyze only the commits that touched the package using the conventionalcommits preset. */
export async function analyzeCommits(
  config: PluginConfig,
  context: ReleaseContext,
): Promise<string | undefined> {
  const result = await analyzeWithConventionalcommits(
    { preset: "conventionalcommits" },
    pluginContext(config, context),
  );
  return result ?? undefined;
}

/** Render package-local Markdown release notes using the conventionalcommits preset. */
export async function generateNotes(
  config: PluginConfig,
  context: ReleaseContext,
): Promise<string> {
  const notes = await generateWithConventionalcommits(
    { preset: "conventionalcommits" },
    pluginContext(config, context),
  );
  // The preset emits "## [version](compare) (date)" headings that slot under the
  // "# Changelog" header. Keep that contract explicit regardless of preset.
  return notes.replace(/^#(?!#)/, "##");
}
