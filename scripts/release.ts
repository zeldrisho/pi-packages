import {
  execFileSync,
  spawnSync,
  type ExecFileSyncOptions,
  type SpawnSyncOptionsWithStringEncoding,
} from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { formatChangelog } from "./format-changelog.ts";

const defaultRoot = resolve(import.meta.dirname, "..");
const tagVersionPattern = "[0-9]+\\.[0-9]+\\.[0-9]+";
const releaseRepository = "zeldrisho/pi-packages";
const releaseRepositoryUrl = `https://github.com/${releaseRepository}`;

interface PackageManifest {
  name: string;
  version: string;
  [key: string]: unknown;
}

export interface PackageInfo {
  directory: string;
  path: string;
  manifestPath: string;
  changelogPath: string;
  name: string;
  shortName: string;
  version: string;
  tag: string;
}

interface RegistryResponse {
  error?: {
    code?: string;
    message?: string;
  };
}

export interface CommandAttempt {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(command: string, args: string[], options?: ExecFileSyncOptions): string;
  attempt(
    command: string,
    args: string[],
    options?: Omit<SpawnSyncOptionsWithStringEncoding, "encoding">,
  ): CommandAttempt;
}

export interface ReleasePlan {
  version: string;
  tag: string;
  notes: string;
}

export interface ReleasePlanner {
  plan(pkg: PackageInfo, requestedVersion?: string): Promise<ReleasePlan | undefined>;
}

export interface ReleaseAutomationOptions {
  root?: string;
  runner?: CommandRunner;
  planner?: ReleasePlanner;
  env?: NodeJS.ProcessEnv;
  stdout?: (value: string) => void;
  log?: (value: string) => void;
  temporaryRoot?: string;
}

export interface ReleaseAutomation {
  packageCatalog(): Promise<PackageInfo[]>;
  componentTags(pkg: PackageInfo): string[];
  hasReleasableChanges(pkg: PackageInfo): boolean;
  assertCurrentVersionIsLatest(pkg: PackageInfo): void;
  status(): Promise<void>;
  prepare(): Promise<void>;
  writeReleaseNotes(packagePath: string, outputPath: string): Promise<void>;
}

type ReleaseType = "major" | "minor" | "patch";

interface PackageCommit {
  hash: string;
  subject: string;
  body: string;
}

const SECTION_TITLES: Record<string, string> = {
  feat: "Added",
  fix: "Fixed",
  perf: "Changed",
  revert: "Changed",
  chore: "Changed",
  docs: "Changed",
  refactor: "Changed",
  security: "Security",
};

// Conventional-commit types that are internal only and not notable enough to list
// in a changelog, per Keep a Changelog 2.0.0 (which defines exactly six types).
const OMITTED_TYPES = new Set(["test", "build", "ci", "style"]);

const SECTION_ORDER = ["feat", "fix", "perf", "revert", "chore", "docs", "refactor", "security"];

/**
 * Creates a command runner rooted at the specified directory.
 *
 * @param root - Working directory for executed commands
 * @returns A runner whose commands return trimmed output or captured execution results
 */
function defaultRunner(root: string): CommandRunner {
  return {
    run(command, args, options = {}) {
      const output = execFileSync(command, args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        ...options,
      });
      return typeof output === "string" ? output.trim() : "";
    },
    attempt(command, args, options = {}) {
      const result = spawnSync(command, args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        ...options,
      });
      return {
        status: result.status,
        stdout: result.stdout ?? "",
        stderr: result.stderr || result.error?.message || "",
      };
    },
  };
}

/** Escapes a literal value before interpolation into a regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Reports whether the specified component tag already exists. */
function tagExists(tag: string, runner: CommandRunner): boolean {
  return (
    runner.attempt("git", ["rev-parse", "--quiet", "--verify", `refs/tags/${tag}`]).status === 0
  );
}

/**
 * Collects the commits that touched a package between an optional base tag and
 * `HEAD`, returning them with their hash, subject, and raw body.
 */
function packageCommits(
  pkg: PackageInfo,
  runner: CommandRunner,
  sinceTag?: string,
): PackageCommit[] {
  const range = sinceTag ? `${sinceTag}..HEAD` : "HEAD";
  const records = runner
    .run("git", ["log", range, "--format=%H%x1f%s%x1f%b%x1e", "--", pkg.path])
    .split("\x1e")
    .filter(Boolean);
  return records.map((record) => {
    const [hash, subject = "", body = ""] = record.split("\x1f");
    return { hash: hash.trim(), subject: subject.trim(), body: body.trim() };
  });
}

/** Maps a conventional-commit subject and body to a release type, or `null`. */
function releaseTypeForCommit(subject: string, body: string): ReleaseType | null {
  const breaking = /^BREAKING[ -]CHANGE:/m.test(body) || /^[A-Za-z]+(\([^)]*\))?!:\s/.test(subject);
  if (breaking) return "major";
  const match = subject.match(/^([A-Za-z]+)(?:\([^)]*\))?!?:\s/);
  if (!match) return null;
  switch (match[1].toLowerCase()) {
    case "feat":
      return "minor";
    case "fix":
    case "perf":
    case "revert":
      return "patch";
    default:
      return null;
  }
}

/** Returns the highest release type across the provided commits, or `null`. */
function highestReleaseType(commits: PackageCommit[]): ReleaseType | null {
  let type: ReleaseType | null = null;
  for (const commit of commits) {
    const commitType = releaseTypeForCommit(commit.subject, commit.body);
    if (commitType === "major") return "major";
    if (commitType === "minor") type = "minor";
    else if (commitType === "patch" && type === null) type = "patch";
  }
  return type;
}

/** Bumps a `major.minor.patch` version by the provided release type. */
function bumpVersion(version: string, type: ReleaseType): string {
  const [major, minor, patch] = version.split(".").map(Number);
  if (type === "major") return `${major + 1}.0.0`;
  if (type === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** Returns the conventional-commit type of a subject, or `null` when absent. */
function commitType(subject: string): string | null {
  const match = subject.match(/^([A-Za-z]+)(?:\([^)]*\))?!?:\s/);
  return match ? match[1].toLowerCase() : null;
}

/** Strips the conventional-commit `type(scope):` prefix from a subject. */
function stripCommitPrefix(subject: string): string {
  return subject.replace(/^([A-Za-z]+)(?:\([^)]*\))?!?:\s/, "").trim();
}

/** Renders one changelog bullet for a commit, linking its hash and pull request. */
function formatCommitLine(commit: PackageCommit): string {
  let line = stripCommitPrefix(commit.subject);
  if (commit.hash) {
    line += ` ([${commit.hash.slice(0, 7)}](${releaseRepositoryUrl}/commit/${commit.hash}))`;
  }
  const pr = commit.subject.match(/\(#(\d+)\)/) ?? commit.body.match(/\(#(\d+)\)/);
  if (pr) {
    line += ` ([#${pr[1]}](${releaseRepositoryUrl}/pull/${pr[1]}))`;
  }
  return line;
}

/** Groups commits into ordered, titled sections for release notes. */
function groupCommits(commits: PackageCommit[]): Array<{ title: string; items: string[] }> {
  const groups = new Map<string, string[]>();
  for (const commit of commits) {
    const type = commitType(commit.subject);
    if (!type || OMITTED_TYPES.has(type)) continue;
    const title = SECTION_TITLES[type] ?? "Changed";
    const items = groups.get(title) ?? [];
    items.push(formatCommitLine(commit));
    groups.set(title, items);
  }
  const result: Array<{ title: string; items: string[] }> = [];
  for (const type of SECTION_ORDER) {
    const title = SECTION_TITLES[type];
    if (title && groups.has(title)) result.push({ title, items: groups.get(title)! });
  }
  return result;
}

/** Renders Markdown release notes for a planned release. */
function generateReleaseNotes(opts: {
  version: string;
  tag: string;
  previousTag?: string;
  commits: PackageCommit[];
}): string {
  const { version, tag, previousTag, commits } = opts;
  const date = new Date().toISOString().slice(0, 10);
  const heading = `## [${version}] - ${date}`;
  const sections = groupCommits(commits);
  const body = sections
    .map(({ title, items }) => `### ${title}\n\n${items.map((item) => `* ${item}`).join("\n")}`)
    .join("\n\n");
  const reference = previousTag
    ? `${releaseRepositoryUrl}/compare/${previousTag}...${tag}`
    : `${releaseRepositoryUrl}/releases/tag/${tag}`;
  // The version heading is a Keep a Changelog reference link; define it once at
  // the bottom of the notes so the heading resolves to the version comparison.
  return `${heading}\n\n${body}\n\n[${version}]: ${reference}\n`;
}

/**
 * Plans a package release without external release tooling: it inspects the
 * package-local conventional commits to derive the next version and renders
 * Markdown notes. An explicit `requestedVersion` (the initial untagged manifest
 * version) is honored without bumping.
 */
function defaultReleasePlanner(root: string): ReleasePlanner {
  const runner = defaultRunner(root);
  return {
    async plan(pkg, requestedVersion) {
      const previousTag = tagExists(pkg.tag, runner) ? pkg.tag : undefined;
      const commits = packageCommits(pkg, runner, previousTag);
      if (commits.length === 0 && !requestedVersion) return undefined;

      const releaseType = highestReleaseType(commits);
      // Callers pass `requestedVersion` for untagged packages and otherwise gate on
      // `hasReleasableChanges`, so a null release type only means nothing to release.
      if (!requestedVersion && !releaseType) return undefined;
      const version = requestedVersion ?? bumpVersion(pkg.version, releaseType ?? "patch");
      const tag = `${pkg.directory}-v${version}`;
      const notes = generateReleaseNotes({ version, tag, previousTag, commits });
      return { version, tag, notes };
    },
  };
}

/**
 * Creates release automation operations configured for a repository.
 *
 * @param options - Optional repository, command runner, environment, output, logging, and temporary-directory settings
 * @returns Release automation operations for discovering, preparing, inspecting, and publishing package releases
 */
export function createReleaseAutomation(options: ReleaseAutomationOptions = {}): ReleaseAutomation {
  const root = resolve(options.root ?? defaultRoot);
  const packagesRoot = join(root, "packages");
  const runner = options.runner ?? defaultRunner(root);
  const env = options.env ?? process.env;
  const planner = options.planner ?? defaultReleasePlanner(root);
  const stdout = options.stdout ?? ((value: string) => process.stdout.write(value));
  const log = options.log ?? console.log;

  async function packageCatalog(): Promise<PackageInfo[]> {
    const entries = await readdir(packagesRoot, { withFileTypes: true });
    return await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(async (entry) => {
          if (!/^[A-Za-z0-9._-]+$/.test(entry.name)) {
            throw new Error(`Invalid package directory name: ${entry.name}`);
          }
          const path = `packages/${entry.name}`;
          const manifestPath = join(root, path, "package.json");
          const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as PackageManifest;
          if (manifest.name !== `@zeldrisho/${entry.name}`) {
            throw new Error(`Unexpected package name in ${manifestPath}: ${manifest.name}`);
          }
          if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) {
            throw new Error(`Invalid package version in ${manifestPath}: ${manifest.version}`);
          }
          return {
            directory: entry.name,
            path,
            manifestPath,
            changelogPath: join(root, path, "CHANGELOG.md"),
            name: manifest.name,
            shortName: entry.name,
            version: manifest.version,
            tag: `${entry.name}-v${manifest.version}`,
          };
        }),
    );
  }

  function componentTags(pkg: PackageInfo): string[] {
    const pattern = new RegExp(`^${escapeRegExp(pkg.directory)}-v${tagVersionPattern}$`);
    return runner
      .run("git", ["tag", "--list", `${pkg.directory}-v*`, "--sort=-v:refname"])
      .split("\n")
      .filter((tag) => pattern.test(tag));
  }

  function assertCurrentVersionIsLatest(pkg: PackageInfo): void {
    const tags = componentTags(pkg);
    if (tags.length === 0) return;
    const latestTag = tags[0];
    const latestVersion = latestTag.slice(`${pkg.directory}-v`.length);
    const tagged = tags.includes(pkg.tag);
    if (
      (tagged && latestTag !== pkg.tag) ||
      (!tagged && compareVersions(pkg.version, latestVersion) <= 0)
    ) {
      throw new Error(
        `Manifest ${pkg.name}@${pkg.version} is inconsistent with latest component tag ${latestTag}`,
      );
    }
  }

  /** Reports whether HEAD is the merge of the generated release pull request. */
  function isReleaseMergePush(): boolean {
    const subject = runner.run("git", ["log", "-1", "--format=%s", "HEAD"]);
    return (
      /^Merge pull request #\d+ from zeldrisho\/release\/prepare$/.test(subject) ||
      subject === "chore: release packages"
    );
  }

  /** Reports whether the tracked changelog already documents the manifest version. */
  async function changelogContainsVersion(pkg: PackageInfo): Promise<boolean> {
    try {
      const changelog = await readFile(pkg.changelogPath, "utf8");
      return new RegExp(`^##\\s*\\[?${escapeRegExp(pkg.version)}`, "m").test(changelog);
    } catch {
      return false;
    }
  }

  function hasReleasableChanges(pkg: PackageInfo): boolean {
    const range = tagExists(pkg.tag, runner) ? `${pkg.tag}..HEAD` : "HEAD";
    const logOutput = runner.run("git", ["log", range, "--format=%s%x1f%b%x1e", "--", pkg.path]);
    return logOutput
      .split("\x1e")
      .filter(Boolean)
      .some((record) => {
        const [subject, body = ""] = record.trimStart().split("\x1f");
        return (
          /^(feat|fix|perf|revert)(\([^)]*\))?!?:/.test(subject) ||
          /^[a-z]+(\([^)]*\))?!:/.test(subject) ||
          /^BREAKING[ -]CHANGE:/m.test(body)
        );
      });
  }

  function isPublished(pkg: PackageInfo): boolean {
    const result = runner.attempt("vp", [
      "pm",
      "view",
      `${pkg.name}@${pkg.version}`,
      "version",
      "--json",
    ]);
    if (result.status === 0) return true;

    let response: RegistryResponse;
    try {
      response = JSON.parse(result.stdout) as RegistryResponse;
    } catch {
      throw new Error(`Unable to check npm for ${pkg.name}@${pkg.version}: ${result.stderr}`);
    }
    if (
      response?.error?.code === "ERR_PNPM_PACKAGE_NOT_FOUND" ||
      response?.error?.code === "ERR_PNPM_NO_MATCHING_VERSION"
    ) {
      return false;
    }
    throw new Error(
      `Unable to check npm for ${pkg.name}@${pkg.version}: ${response?.error?.message ?? result.stderr}`,
    );
  }

  function githubReleaseExists(tag: string): boolean {
    const repository = env.GITHUB_REPOSITORY;
    if (!repository) throw new Error("GITHUB_REPOSITORY is required to inspect GitHub releases");

    const result = runner.attempt("gh", [
      "api",
      `repos/${repository}/releases/tags/${tag}`,
      "--silent",
    ]);
    if (result.status === 0) return true;
    if (result.stderr.includes("HTTP 404")) return false;
    throw new Error(`Unable to check GitHub release ${tag}: ${result.stderr}`);
  }

  async function status(): Promise<void> {
    const pending = [];
    const releaseMerge = isReleaseMergePush();
    for (const pkg of await packageCatalog()) {
      assertCurrentVersionIsLatest(pkg);
      const tagged = tagExists(pkg.tag, runner);
      const published = isPublished(pkg);
      const released = tagged && githubReleaseExists(pkg.tag);
      // Tagged packages that miss a GitHub release or npm version are always retried.
      // Untagged manifest versions are released only when this push merges the generated
      // release pull request, or when their changelog entry already landed on main (the
      // release pull request was merged but the release did not complete).
      const pendingInitialRelease =
        !tagged && (releaseMerge || (await changelogContainsVersion(pkg)));
      if ((tagged && (!published || !released)) || pendingInitialRelease) {
        pending.push({
          package: pkg.path,
          name: pkg.name,
          shortName: pkg.shortName,
          version: pkg.version,
          tag: pkg.tag,
          publish: !published,
          released,
        });
      }
    }
    stdout(JSON.stringify({ include: pending }));
  }

  async function prepare(): Promise<void> {
    const packages = await packageCatalog();
    packages.forEach(assertCurrentVersionIsLatest);

    const planned = [];
    for (const pkg of packages) {
      const tagged = tagExists(pkg.tag, runner);
      if (tagged && !hasReleasableChanges(pkg)) continue;
      if (!tagged && (await changelogContainsVersion(pkg))) continue;

      // Keep initial manifest versions (for example 0.1.0) while still using the
      // release automation to analyze package-local commits and generate notes.
      // Later releases use its calculated version directly.
      const plan = await planner.plan(pkg, tagged ? undefined : pkg.version);
      if (!plan) continue;
      const prefix = `${pkg.directory}-v`;
      if (!plan.tag.startsWith(prefix)) {
        throw new Error(`Planner returned an unexpected tag for ${pkg.name}: ${plan.tag}`);
      }
      if (!/^\d+\.\d+\.\d+$/.test(plan.version) || plan.tag !== `${prefix}${plan.version}`) {
        throw new Error(`Planner returned an invalid version for ${pkg.name}: ${plan.version}`);
      }

      let changelog: string;
      try {
        changelog = await readFile(pkg.changelogPath, "utf8");
      } catch (error) {
        // Treat missing CHANGELOG.md as empty so it reaches the header validation below
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          changelog = "";
        } else {
          throw error;
        }
      }
      const changelogHeader = "# Changelog";
      if (!changelog.startsWith(changelogHeader)) {
        throw new Error(`Invalid changelog header for ${pkg.name}`);
      }
      const existingNotes = changelog.slice(changelogHeader.length).trim();
      const composed = `${changelogHeader}\n\n${plan.notes.trim()}${existingNotes ? `\n\n${existingNotes}` : ""}\n`;
      await writeFile(
        pkg.changelogPath,
        formatChangelog(composed, {
          repoUrl: releaseRepositoryUrl,
          packageDirectory: pkg.directory,
        }),
      );
      if (tagged) {
        const manifest = JSON.parse(await readFile(pkg.manifestPath, "utf8")) as PackageManifest;
        manifest.version = plan.version;
        await writeFile(pkg.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      }
      planned.push({ ...pkg, version: plan.version, tag: plan.tag });
    }

    const bodyPath = env.RELEASE_PR_BODY;
    if (bodyPath && planned.length > 0) {
      const releases = planned.map((pkg) => `- \`${pkg.name}\` → \`${pkg.version}\``).join("\n");
      await writeFile(
        bodyPath,
        `Automated version and changelog updates generated by the release automation.\n\n${releases}\n`,
      );
    }

    log(
      planned.length === 0
        ? "No releasable package changes found."
        : `Prepared ${planned.length} package release(s): ${planned.map((pkg) => pkg.tag).join(", ")}`,
    );
  }

  /**
   * Extracts the changelog section for the package's current version and writes
   * it to `outputPath`, for use as GitHub release notes.
   */
  async function writeReleaseNotes(packagePath: string, outputPath: string): Promise<void> {
    const pkg = (await packageCatalog()).find((candidate) => candidate.path === packagePath);
    if (!pkg) throw new Error(`Unknown package path: ${packagePath}`);
    const changelog = await readFile(pkg.changelogPath, "utf8");
    const heading = new RegExp(`^##\\s+\\[?${escapeRegExp(pkg.version)}(?:\\]|\\s|$)`, "m");
    const start = changelog.search(heading);
    if (start < 0) throw new Error(`Changelog does not contain ${pkg.name}@${pkg.version}`);
    const remainder = changelog.slice(start);
    const nextHeading = remainder.slice(1).search(/^##\s+/m);
    const notes = nextHeading < 0 ? remainder : remainder.slice(0, nextHeading + 1);
    // Carry the version's link definition so the heading resolves in the release notes.
    const referenceLine = changelog
      .split("\n")
      .find((line) => line.startsWith(`[${pkg.version}]:`));
    const suffix = referenceLine ? `\n\n${referenceLine}` : "";
    // Release notes are written to an explicitly provided path. Normalize it so
    // `..` segments cannot escape, and reject relative paths that would resolve
    // outside the working directory. The resolved path must equal the working
    // directory or sit underneath it (separator-bounded) so a sibling directory
    // sharing the cwd prefix cannot bypass the check. Absolute paths chosen by the
    // caller (the CI runner temp directory or a local file) are trusted.
    const resolvedCwd = resolve(process.cwd());
    const resolvedPath = resolve(outputPath);
    if (
      !isAbsolute(outputPath) &&
      !(resolvedPath === resolvedCwd || resolvedPath.startsWith(resolvedCwd + sep))
    ) {
      throw new Error(
        `Refusing to write release notes outside the working directory: ${outputPath}`,
      );
    }
    await writeFile(resolvedPath, `${notes.trim()}${suffix}\n`);
  }

  return {
    packageCatalog,
    componentTags,
    hasReleasableChanges,
    assertCurrentVersionIsLatest,
    status,
    prepare,
    writeReleaseNotes,
  };
}

/**
 * Compares two dot-separated version strings numerically.
 *
 * @param left - The first version to compare
 * @param right - The second version to compare
 * @returns A negative number if `left` is lower, a positive number if `left` is higher, or `0` if they are equal
 */
function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

/**
 * Runs the release automation command selected by the provided arguments.
 *
 * @param args - Command-line arguments specifying the release operation and, when required, its package path and output path
 * @param automation - Release operations used to dispatch the selected command
 */
export async function runReleaseCli(
  args = process.argv.slice(2),
  automation: ReleaseAutomation = createReleaseAutomation(),
): Promise<void> {
  const [command, argument, secondArgument] = args;
  switch (command) {
    case "status":
      await automation.status();
      break;
    case "prepare":
      await automation.prepare();
      break;
    case "notes":
      if (!argument || !secondArgument) {
        throw new Error("A package path and output path are required");
      }
      await automation.writeReleaseNotes(argument, secondArgument);
      break;
    default:
      throw new Error("Usage: node release.ts <status|prepare|notes>");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runReleaseCli();
}
