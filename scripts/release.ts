import { readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const defaultRoot = resolve(import.meta.dirname, "..");
const tagPattern = /^([A-Za-z0-9._-]+)-v(\d+\.\d+\.\d+)$/;

interface PackageManifest {
  name: string;
  version: string;
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

export interface ReleaseAutomation {
  packageCatalog(): Promise<PackageInfo[]>;
  resolvePackageByTag(tag: string): Promise<PackageInfo>;
  writeReleaseNotes(packagePath: string, outputPath: string): Promise<void>;
}

export interface ReleaseAutomationOptions {
  root?: string;
  stdout?: (value: string) => void;
}

/**
 * Creates release-tooling operations for the repository.
 *
 * The agent owns the changelog and version: it bumps `package.json`, writes the
 * `CHANGELOG.md` entry by hand, and pushes a `<package>-v<version>` tag. These
 * operations only resolve that tag to its package and read the CHANGELOG section
 * for use as GitHub release notes.
 *
 * @param options - Optional repository root
 * @returns Operations for discovering, resolving, and rendering package releases
 */
export function createReleaseAutomation(options: ReleaseAutomationOptions = {}): ReleaseAutomation {
  const root = resolve(options.root ?? defaultRoot);
  const packagesRoot = join(root, "packages");

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
          const manifest: PackageManifest = JSON.parse(await readFile(manifestPath, "utf8"));
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

  /**
   * Resolves a `<package>-v<version>` tag to its package, verifying the tag
   * version matches the manifest version so a missing bump is caught before
   * publication.
   */
  async function resolvePackageByTag(tag: string): Promise<PackageInfo> {
    const match = tagPattern.exec(tag);
    if (!match) {
      throw new Error(`Tag ${tag} does not match <package>-v<version>`);
    }
    const [, directory, version] = match;
    const pkg = (await packageCatalog()).find((candidate) => candidate.directory === directory);
    if (!pkg) {
      throw new Error(`No package matches the tag ${tag}`);
    }
    if (pkg.version !== version) {
      throw new Error(
        `Tag version ${version} does not match ${pkg.name} manifest version ${pkg.version}`,
      );
    }
    return pkg;
  }

  /**
   * Extracts the changelog section for the package's current version and writes
   * it to `outputPath`, for use as GitHub release notes.
   */
  async function writeReleaseNotes(packagePath: string, outputPath: string): Promise<void> {
    const pkg = (await packageCatalog()).find((candidate) => candidate.path === packagePath);
    if (!pkg) throw new Error(`Unknown package path: ${packagePath}`);
    const changelog = await readFile(pkg.changelogPath, "utf8");
    const heading = [...changelog.matchAll(/^##\s+\[?(\d+\.\d+\.\d+)(?:\]|\s|$)/gm)].find(
      (match) => match[1] === pkg.version,
    );
    if (heading?.index === undefined) {
      throw new Error(`Changelog does not contain ${pkg.name}@${pkg.version}`);
    }
    const start = heading.index;
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

  return { packageCatalog, resolvePackageByTag, writeReleaseNotes };
}

/**
 * Runs the release tooling command selected by the provided arguments.
 *
 * @param args - Command-line arguments specifying the operation and, when required, its arguments
 * @param automation - Release operations used to dispatch the selected command
 */
export async function runReleaseCli(
  args = process.argv.slice(2),
  automation: ReleaseAutomation = createReleaseAutomation(),
): Promise<void> {
  const [command, argument, secondArgument] = args;
  switch (command) {
    case "package":
      if (!argument) throw new Error("A tag is required");
      process.stdout.write(JSON.stringify(await automation.resolvePackageByTag(argument)));
      break;
    case "notes":
      if (!argument || !secondArgument) {
        throw new Error("A package path and output path are required");
      }
      await automation.writeReleaseNotes(argument, secondArgument);
      break;
    default:
      throw new Error("Usage: node release.ts <package|notes>");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runReleaseCli();
}
