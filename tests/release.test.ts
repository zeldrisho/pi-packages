import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createReleaseAutomation, runReleaseCli, type PackageInfo } from "../scripts/release.ts";

const temporaryDirectories: string[] = [];

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function createRepository(version = "1.0.0"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "release-repository-test-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "packages", "alpha"), { recursive: true });
  await writeFile(
    join(root, "packages", "alpha", "package.json"),
    `${JSON.stringify({ name: "@zeldrisho/alpha", version }, null, 2)}\n`,
  );
  await writeFile(join(root, "packages", "alpha", "CHANGELOG.md"), "# Changelog\n");
  git(root, "init", "--quiet");
  git(root, "config", "user.email", "release-test@example.test");
  git(root, "config", "user.name", "Release Test");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "feat: initial package");
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("package catalog", () => {
  it("discovers package directories and computes their component tag", async () => {
    const root = await createRepository("1.2.3");
    const automation = createReleaseAutomation({ root });
    const catalog = await automation.packageCatalog();

    expect(catalog).toEqual<PackageInfo[]>([
      {
        directory: "alpha",
        path: "packages/alpha",
        manifestPath: join(root, "packages/alpha/package.json"),
        changelogPath: join(root, "packages/alpha/CHANGELOG.md"),
        name: "@zeldrisho/alpha",
        shortName: "alpha",
        version: "1.2.3",
        tag: "alpha-v1.2.3",
      },
    ]);
  });
});

describe("tag resolution", () => {
  it("resolves a well-formed tag to its package and confirms the manifest version", async () => {
    const root = await createRepository("1.0.0");
    const automation = createReleaseAutomation({ root });

    const pkg = await automation.resolvePackageByTag("alpha-v1.0.0");

    expect(pkg.path).toBe("packages/alpha");
    expect(pkg.version).toBe("1.0.0");
  });

  it("rejects a tag whose version does not match the manifest", async () => {
    const root = await createRepository("1.0.0");
    const automation = createReleaseAutomation({ root });

    await expect(automation.resolvePackageByTag("alpha-v1.0.1")).rejects.toThrow(
      "does not match @zeldrisho/alpha manifest version 1.0.0",
    );
  });

  it("rejects a tag with no matching package", async () => {
    const root = await createRepository();
    const automation = createReleaseAutomation({ root });

    await expect(automation.resolvePackageByTag("missing-v1.0.0")).rejects.toThrow(
      "No package matches the tag",
    );
  });

  it("rejects a malformed tag", async () => {
    const automation = createReleaseAutomation();

    await expect(automation.resolvePackageByTag("alpha-not-semver")).rejects.toThrow(
      "does not match <package>-v<version>",
    );
  });
});

describe("release notes extraction", () => {
  it("rejects invalid package paths", async () => {
    const root = await createRepository();
    const automation = createReleaseAutomation({ root });
    await expect(
      automation.writeReleaseNotes("packages/missing", join(root, "notes.md")),
    ).rejects.toThrow("Unknown package path");
  });

  it("extracts the version section from the changelog", async () => {
    const root = await createRepository();
    await writeFile(
      join(root, "packages/alpha/CHANGELOG.md"),
      "# Changelog\n\n## 1.0.0 (2026-08-05)\n\n* Initial release\n\n## 0.0.1\n\n* Bootstrap\n",
    );
    const automation = createReleaseAutomation({ root });
    const notesPath = join(root, "notes.md");
    await automation.writeReleaseNotes("packages/alpha", notesPath);
    const notes = await readFile(notesPath, "utf8");
    expect(notes).toContain("## 1.0.0");
    expect(notes).not.toContain("## 0.0.1");
  });

  it("throws when the changelog lacks the version entry", async () => {
    const root = await createRepository();
    const automation = createReleaseAutomation({ root });
    await expect(
      automation.writeReleaseNotes("packages/alpha", join(root, "notes.md")),
    ).rejects.toThrow("Changelog does not contain @zeldrisho/alpha@1.0.0");
  });

  it("rejects output paths that escape via a sibling-directory prefix", async () => {
    const root = await createRepository();
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
  it("loads with Node's native TypeScript support", () => {
    expect(() =>
      execFileSync(
        process.execPath,
        ["--input-type=module", "--eval", "await import('./scripts/release.ts')"],
        { cwd: process.cwd() },
      ),
    ).not.toThrow();
  });

  function fakeAutomation() {
    const resolvePackageByTag = vi.fn().mockResolvedValue({ path: "packages/alpha" });
    const writeReleaseNotes = vi.fn();
    return {
      automation: {
        packageCatalog: vi.fn(),
        resolvePackageByTag,
        writeReleaseNotes,
      },
      resolvePackageByTag,
      writeReleaseNotes,
    };
  }

  it.each([
    ["package", "alpha-v1.0.0", undefined],
    ["notes", "packages/alpha", "notes.md"],
  ] as const)("dispatches %s", async (command, argument, secondArgument) => {
    const fake = fakeAutomation();
    await runReleaseCli(
      secondArgument
        ? [command, argument, secondArgument]
        : argument
          ? [command, argument]
          : [command],
      fake.automation,
    );

    if (command === "package")
      expect(fake.resolvePackageByTag).toHaveBeenCalledWith("alpha-v1.0.0");
    else expect(fake.writeReleaseNotes).toHaveBeenCalledWith("packages/alpha", "notes.md");
  });

  it("rejects a missing argument for package", async () => {
    await expect(runReleaseCli(["package"], fakeAutomation().automation)).rejects.toThrow(
      "A tag is required",
    );
  });

  it("rejects a missing output path for notes", async () => {
    await expect(
      runReleaseCli(["notes", "packages/alpha"], fakeAutomation().automation),
    ).rejects.toThrow("A package path and output path are required");
  });

  it("rejects unknown commands with usage", async () => {
    await expect(runReleaseCli(["unknown"], fakeAutomation().automation)).rejects.toThrow("Usage:");
  });
});
