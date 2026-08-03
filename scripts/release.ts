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

const root = resolve(import.meta.dirname, "..");
const packagesRoot = join(root, "packages");
const tagVersionPattern = "[0-9]+\\.[0-9]+\\.[0-9]+";

interface PackageManifest {
  name: string;
  version: string;
  [key: string]: unknown;
}

interface PackageInfo {
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

function run(command: string, args: string[], options: ExecFileSyncOptions = {}): string {
  const output = execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  return typeof output === "string" ? output.trim() : "";
}

function attempt(
  command: string,
  args: string[],
  options: Omit<SpawnSyncOptionsWithStringEncoding, "encoding"> = {},
) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

async function packageCatalog(): Promise<PackageInfo[]> {
  const entries = await readdir(packagesRoot, { withFileTypes: true });
  return Promise.all(
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
  return attempt("git", ["rev-parse", "--quiet", "--verify", `refs/tags/${tag}`]).status === 0;
}

function componentTags(pkg: PackageInfo): string[] {
  const pattern = new RegExp(`^${pkg.directory}-v${tagVersionPattern}$`);
  return run("git", ["tag", "--list", `${pkg.directory}-v*`, "--sort=-v:refname"])
    .split("\n")
    .filter((tag) => pattern.test(tag));
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
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
    `^${pkg.directory}-v${tagVersionPattern}$`,
    "--include-path",
    `${pkg.path}/**`,
  ];
}

function hasReleasableChanges(pkg: PackageInfo): boolean {
  const log = run("git", ["log", `${pkg.tag}..HEAD`, "--format=%s%x1f%b%x1e", "--", pkg.path]);
  return log
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
  const result = attempt("vp", ["pm", "view", `${pkg.name}@${pkg.version}`, "version", "--json"]);
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
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error("GITHUB_REPOSITORY is required to inspect GitHub releases");

  const result = attempt("gh", ["api", `repos/${repository}/releases/tags/${tag}`, "--silent"]);
  if (result.status === 0) return true;
  if (result.stderr.includes("HTTP 404")) return false;
  throw new Error(`Unable to check GitHub release ${tag}: ${result.stderr}`);
}

async function status(): Promise<void> {
  const pending = [];
  for (const pkg of await packageCatalog()) {
    assertCurrentVersionIsLatest(pkg);
    const tagged = tagExists(pkg.tag);
    const published = isPublished(pkg);
    const released = tagged && githubReleaseExists(pkg.tag);
    if (!tagged || !published || !released) {
      pending.push({
        package: pkg.path,
        name: pkg.name,
        version: pkg.version,
        tag: pkg.tag,
        publish: !published,
      });
    }
  }
  process.stdout.write(JSON.stringify({ include: pending }));
}

async function prepare(): Promise<void> {
  const packages = await packageCatalog();
  packages.forEach(assertCurrentVersionIsLatest);
  const untagged = packages.filter((pkg) => !tagExists(pkg.tag));
  if (untagged.length > 0) {
    throw new Error(
      `Refusing to prepare another release while these manifest versions are untagged: ${untagged.map((pkg) => pkg.tag).join(", ")}`,
    );
  }

  const planned = [];
  for (const pkg of packages) {
    if (!hasReleasableChanges(pkg)) continue;
    const nextTag = run("git-cliff", [...cliffArguments(pkg), "--unreleased", "--bumped-version"]);
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
    await writeFile(pkg.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    run("git-cliff", [
      ...cliffArguments(pkg),
      "--unreleased",
      "--tag",
      nextTag,
      "--prepend",
      pkg.changelogPath,
    ]);
    planned.push({ ...pkg, version, tag: nextTag });
  }

  const bodyPath = process.env.RELEASE_PR_BODY;
  if (bodyPath && planned.length > 0) {
    const releases = planned.map((pkg) => `- \`${pkg.name}\` → \`${pkg.version}\``).join("\n");
    await writeFile(
      bodyPath,
      `Automated version and changelog updates generated by git-cliff.\n\n${releases}\n`,
    );
  }

  console.log(
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
    console.log(`GitHub release ${pkg.tag} already exists.`);
    return;
  }

  const tagged = tagExists(pkg.tag);
  const target = tagged ? pkg.tag : process.env.GITHUB_SHA || "HEAD";
  const tags = componentTags(pkg).filter((tag) => tag !== pkg.tag);
  const previousTag = tags[0];
  const range = previousTag ? `${previousTag}..${target}` : target;
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "git-cliff-release-"));
  try {
    const notesPath = join(temporaryDirectory, `${basename(pkg.path)}.md`);
    const notes = run("git-cliff", [
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
    run("gh", args, { stdio: "inherit" });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

const [command, argument] = process.argv.slice(2);
switch (command) {
  case "status":
    await status();
    break;
  case "prepare":
    await prepare();
    break;
  case "ensure-github-release":
    if (!argument) throw new Error("A package path is required");
    await ensureGithubRelease(argument);
    break;
  default:
    throw new Error("Usage: node scripts/release.ts <status|prepare|ensure-github-release>");
}
