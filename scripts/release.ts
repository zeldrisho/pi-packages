import {
  execFileSync,
  spawnSync,
  type ExecFileSyncOptions,
  type SpawnSyncOptionsWithStringEncoding,
} from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const defaultRoot = resolve(import.meta.dirname, "..");
const tagVersionPattern = "[0-9]+\\.[0-9]+\\.[0-9]+";

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

export interface ReleaseAutomationOptions {
  root?: string;
  runner?: CommandRunner;
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
  ensureGithubRelease(packagePath: string): Promise<void>;
}

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
            version: manifest.version,
            tag: `${entry.name}-v${manifest.version}`,
          };
        }),
    );
  }

  function tagExists(tag: string): boolean {
    return (
      runner.attempt("git", ["rev-parse", "--quiet", "--verify", `refs/tags/${tag}`]).status === 0
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

  function cliffArguments(pkg: PackageInfo): string[] {
    return [
      "--no-exec",
      "--config",
      "cliff.toml",
      "--tag-pattern",
      `^${escapeRegExp(pkg.directory)}-v${tagVersionPattern}$`,
      "--include-path",
      `${pkg.path}/**`,
    ];
  }

  /** Reports whether HEAD is the merge of the generated release pull request. */
  function isReleaseMergePush(): boolean {
    const subject = runner.run("git", ["log", "-1", "--format=%s", "HEAD"]);
    return (
      /^Merge pull request #\d+ from zeldrisho\/git-cliff\/release$/.test(subject) ||
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
    const range = tagExists(pkg.tag) ? `${pkg.tag}..HEAD` : "HEAD";
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
      const tagged = tagExists(pkg.tag);
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
          version: pkg.version,
          tag: pkg.tag,
          publish: !published,
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
      if (tagExists(pkg.tag)) {
        if (!hasReleasableChanges(pkg)) continue;
        const nextTag = runner.run("git-cliff", [
          ...cliffArguments(pkg),
          "--unreleased",
          "--bumped-version",
        ]);
        if (nextTag === pkg.tag) continue;

        const prefix = `${pkg.directory}-v`;
        if (!nextTag.startsWith(prefix)) {
          throw new Error(`git-cliff returned an unexpected tag for ${pkg.name}: ${nextTag}`);
        }
        const version = nextTag.slice(prefix.length);
        if (!/^\d+\.\d+\.\d+$/.test(version)) {
          throw new Error(`git-cliff returned an invalid version for ${pkg.name}: ${version}`);
        }

        const manifest = JSON.parse(await readFile(pkg.manifestPath, "utf8")) as PackageManifest;
        manifest.version = version;
        runner.run("git-cliff", [
          ...cliffArguments(pkg),
          "--unreleased",
          "--tag",
          nextTag,
          "--prepend",
          pkg.changelogPath,
        ]);
        await writeFile(pkg.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        planned.push({ ...pkg, version, tag: nextTag });
      } else if (!(await changelogContainsVersion(pkg))) {
        // The untagged manifest version is the pending initial release (for example a newly
        // bootstrapped package). Add its changelog entry to the generated release pull request
        // without touching the version; the release itself happens when that pull request merges.
        runner.run("git-cliff", [
          ...cliffArguments(pkg),
          "--unreleased",
          "--tag",
          pkg.tag,
          "--prepend",
          pkg.changelogPath,
        ]);
        planned.push({ ...pkg, version: pkg.version, tag: pkg.tag });
      }
    }

    const bodyPath = env.RELEASE_PR_BODY;
    if (bodyPath && planned.length > 0) {
      const releases = planned.map((pkg) => `- \`${pkg.name}\` → \`${pkg.version}\``).join("\n");
      await writeFile(
        bodyPath,
        `Automated version and changelog updates generated by git-cliff.\n\n${releases}\n`,
      );
    }

    log(
      planned.length === 0
        ? "No releasable package changes found."
        : `Prepared ${planned.length} package release(s): ${planned.map((pkg) => pkg.tag).join(", ")}`,
    );
  }

  async function ensureGithubRelease(packagePath: string): Promise<void> {
    const pkg = (await packageCatalog()).find((candidate) => candidate.path === packagePath);
    if (!pkg) throw new Error(`Unknown package path: ${packagePath}`);
    assertCurrentVersionIsLatest(pkg);
    if (githubReleaseExists(pkg.tag)) {
      log(`GitHub release ${pkg.tag} already exists.`);
      return;
    }

    const tagged = tagExists(pkg.tag);
    const target = tagged ? pkg.tag : env.GITHUB_SHA || runner.run("git", ["rev-parse", "HEAD"]);
    const tags = componentTags(pkg).filter((tag) => tag !== pkg.tag);
    const previousTag = tags[0];
    const range = previousTag ? `${previousTag}..${target}` : target;
    const temporaryDirectory = await mkdtemp(
      join(options.temporaryRoot ?? tmpdir(), "git-cliff-release-"),
    );
    try {
      const notesPath = join(temporaryDirectory, `${basename(pkg.path)}.md`);
      const notes = runner.run("git-cliff", [
        ...cliffArguments(pkg),
        "--tag",
        pkg.tag,
        "--strip",
        "header",
        range,
      ]);
      await writeFile(notesPath, `${notes}\n`);

      const args = [
        "release",
        "create",
        pkg.tag,
        "--title",
        `${pkg.name} v${pkg.version}`,
        "--notes-file",
        notesPath,
      ];
      if (tagged) args.push("--verify-tag");
      else args.push("--target", target);
      runner.run("gh", args, { stdio: "inherit" });
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  return {
    packageCatalog,
    componentTags,
    hasReleasableChanges,
    assertCurrentVersionIsLatest,
    status,
    prepare,
    ensureGithubRelease,
  };
}

/**
 * Runs the release automation command selected by the provided arguments.
 *
 * @param args - Command-line arguments specifying the release operation and, when required, its package path
 * @param automation - Release operations used to dispatch the selected command
 */
export async function runReleaseCli(
  args = process.argv.slice(2),
  automation: ReleaseAutomation = createReleaseAutomation(),
): Promise<void> {
  const [command, argument] = args;
  switch (command) {
    case "status":
      await automation.status();
      break;
    case "prepare":
      await automation.prepare();
      break;
    case "ensure-github-release":
      if (!argument) throw new Error("A package path is required");
      await automation.ensureGithubRelease(argument);
      break;
    default:
      throw new Error("Usage: node scripts/release.ts <status|prepare|ensure-github-release>");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runReleaseCli();
}
