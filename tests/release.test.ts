import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createReleaseAutomation, runReleaseCli, type PackageInfo } from "../scripts/release.ts";

const temporaryDirectories: string[] = [];

async function createPackageFixture(version = "1.0.0"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "release-repository-test-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "packages", "alpha"), { recursive: true });
  await writeFile(
    join(root, "packages", "alpha", "package.json"),
    `${JSON.stringify({ name: "@zeldrisho/alpha", version }, null, 2)}\n`,
  );
  await writeFile(join(root, "packages", "alpha", "CHANGELOG.md"), "# Changelog\n");

  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("tag resolution", () => {
  it("resolves release tags only for known packages at the manifest version", async () => {
    const root = await createPackageFixture("1.2.3");
    const automation = createReleaseAutomation({ root });

    const alpha: PackageInfo = {
      directory: "alpha",
      path: "packages/alpha",
      manifestPath: join(root, "packages/alpha/package.json"),
      changelogPath: join(root, "packages/alpha/CHANGELOG.md"),
      name: "@zeldrisho/alpha",
      shortName: "alpha",
      version: "1.2.3",
      tag: "alpha-v1.2.3",
    };

    await expect(automation.packageCatalog()).resolves.toEqual([alpha]);
    await expect(automation.resolvePackageByTag("alpha-v1.2.3")).resolves.toEqual(alpha);

    const samples = [
      ["alpha-v1.0.1", "does not match @zeldrisho/alpha manifest version 1.2.3"],
      ["missing-v1.0.0", "No package matches the tag"],
      ["alpha-not-semver", "does not match <package>-v<version>"],
    ] as const;

    for (const [tag, message] of samples) {
      await expect.soft(automation.resolvePackageByTag(tag), tag).rejects.toThrow(message);
    }
  });
});

describe("release notes extraction", () => {
  it("writes only the matching version section for a known package", async () => {
    const root = await createPackageFixture();
    const automation = createReleaseAutomation({ root });
    const notesPath = join(root, "notes.md");

    await expect
      .soft(automation.writeReleaseNotes("packages/missing", notesPath))
      .rejects.toThrow("Unknown package path");
    await expect
      .soft(automation.writeReleaseNotes("packages/alpha", notesPath))
      .rejects.toThrow("Changelog does not contain @zeldrisho/alpha@1.0.0");

    await writeFile(
      join(root, "packages/alpha/CHANGELOG.md"),
      "# Changelog\n\n## 1.0.0 (2026-08-05)\n\n* Initial release\n\n## 0.0.1\n\n* Bootstrap\n",
    );
    await automation.writeReleaseNotes("packages/alpha", notesPath);
    const notes = await readFile(notesPath, "utf8");
    expect(notes).toContain("## 1.0.0");
    expect(notes).not.toContain("## 0.0.1");
  });

  it("rejects output paths that escape via a sibling-directory prefix", async () => {
    const root = await createPackageFixture();
    await writeFile(
      join(root, "packages/alpha/CHANGELOG.md"),
      "# Changelog\n\n## 1.0.0 (2026-08-05)\n\n* Initial release\n\n## 0.0.1\n\n* Bootstrap\n",
    );
    const automation = createReleaseAutomation({ root });
    const sibling = join("..", `${basename(process.cwd())}-evil`, "notes.md");
    await expect(automation.writeReleaseNotes("packages/alpha", sibling)).rejects.toThrow(
      "outside the working directory",
    );
  });
});

describe("release CLI", () => {
  it("prints the tagged package and writes its release notes under native Node", async () => {
    const root = await createPackageFixture();
    await mkdir(join(root, "scripts"));
    await copyFile(
      new URL("../scripts/release.ts", import.meta.url),
      join(root, "scripts/release.ts"),
    );
    const notes = "## 1.0.0\n\n* Initial release\n";
    await writeFile(join(root, "packages/alpha/CHANGELOG.md"), `# Changelog\n\n${notes}`);

    const run = (...args: string[]): string =>
      execFileSync(process.execPath, ["scripts/release.ts", ...args], {
        cwd: root,
        encoding: "utf8",
      });

    expect(JSON.parse(run("package", "alpha-v1.0.0"))).toMatchObject({
      name: "@zeldrisho/alpha",
      path: "packages/alpha",
      tag: "alpha-v1.0.0",
    });
    run("notes", "packages/alpha", "notes.md");
    expect(await readFile(join(root, "notes.md"), "utf8")).toBe(notes);
  });

  it("rejects missing arguments and unknown commands", async () => {
    const samples = [
      [["package"], "A tag is required"],
      [["notes", "packages/alpha"], "A package path and output path are required"],
      [["unknown"], "Usage:"],
    ] satisfies [string[], string][];

    for (const [args, message] of samples) {
      await expect.soft(runReleaseCli(args), args.join(" ")).rejects.toThrow(message);
    }
  });
});
