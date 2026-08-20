import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, it } from "vite-plus/test";

const root = resolve(import.meta.dirname, "..");
const packagesDirectory = join(root, "packages");
const packageDirectories = (await readdir(packagesDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const readme = await readFile(join(root, "README.md"), "utf8");
const workspace = await readFile(join(root, "pnpm-workspace.yaml"), "utf8");
const lockfile = await readFile(join(root, "pnpm-lock.yaml"), "utf8");
const releaseWorkflow = await readFile(join(root, ".github/workflows/release.yml"), "utf8");
const expectedFiles = ["src", "README.md", "CHANGELOG.md", "LICENSE"];
const expectedScripts = {
  check: "vp check",
  test: "vp test",
  "test:watch": "vp test --watch",
  lint: "vp lint",
  "lint:fix": "vp lint --fix",
  format: "vp fmt --write",
  typecheck: "vp check --no-fmt --no-lint",
};
const expectedTypeScriptConfiguration = {
  extends: "../../tsconfig.base.json",
  include: ["src", "tests"],
};
const synchronizedInfrastructurePairs = [
  ["packages/pi-web-fetch/src/cache.ts", "packages/pi-web-search/src/cache.ts"],
  ["packages/pi-web-fetch/src/inflight.ts", "packages/pi-web-search/src/inflight.ts"],
  ["packages/pi-web-fetch/src/render.ts", "packages/pi-web-search/src/render.ts"],
];

/**
 * Parses the flat version-pinned entries from the workspace overrides section.
 *
 * Only the top-level two-space-indented `name: value` entries of the overrides
 * block are read; comments and blank lines are skipped. The section ends at the
 * next top-level key. Catalog aliases (`vite` and `vitest`) are returned as
 * `catalog:` values so callers can skip them.
 */
function parseOverrides(yaml: string): Map<string, string> {
  const overrides = new Map<string, string>();
  let inOverrides = false;
  for (const line of yaml.split(/\r?\n/)) {
    if (!inOverrides) {
      if (/^overrides:\s*$/.test(line)) inOverrides = true;
      continue;
    }
    if (/^\S/.test(line)) break;
    const match = line.match(/^ {2}([A-Za-z0-9@._/-]+):\s*(?:"([^"]*)"|(\S+))?/);
    if (match) overrides.set(match[1], match[2] ?? match[3] ?? "");
  }
  return overrides;
}

function sameValues(actual: string[], expected: string[]) {
  const compare = (left: string, right: string) => left.localeCompare(right);
  return JSON.stringify([...actual].sort(compare)) === JSON.stringify([...expected].sort(compare));
}

function fail(message: string): never {
  throw new Error(`Repository contract violation: ${message}`);
}

describe("repository contracts", () => {
  it("creates GitHub releases with softprops/action-gh-release on component tag push", () => {
    if (!releaseWorkflow.includes("uses: softprops/action-gh-release")) {
      fail("the release job must create GitHub releases with softprops/action-gh-release");
    }
    if (!releaseWorkflow.includes("tags:") || !releaseWorkflow.includes('"*-v*.*.*"')) {
      fail("the release workflow must trigger on component tag pushes (<package>-v<version>)");
    }
    if (!releaseWorkflow.includes("id-token: write")) {
      fail("the publishing job must grant id-token: write for npm trusted publishing");
    }
    if (!releaseWorkflow.includes("environment: publish")) {
      fail("npm publication must require approval through the protected publish environment");
    }
    if (!releaseWorkflow.includes("shortName")) {
      fail("the GitHub release name must use the package short name, not the scoped npm name");
    }
    if (
      !releaseWorkflow.includes("scripts/release.ts package") ||
      !releaseWorkflow.includes("scripts/release.ts notes")
    ) {
      fail(
        "the release job must resolve the package from the tag and read release notes from the CHANGELOG",
      );
    }
  });

  it("README catalog matches packages/", () => {
    const documentedDirectories = [...readme.matchAll(/\]\(packages\/([A-Za-z0-9._-]+)\)/g)].map(
      (match) => match[1],
    );
    if (!sameValues(documentedDirectories, packageDirectories)) {
      fail(
        `README package catalog does not match packages/: documented=${documentedDirectories
          .sort((left, right) => left.localeCompare(right))
          .join(",")} actual=${packageDirectories.join(",")}`,
      );
    }
  });

  it("synchronized infrastructure files are byte-for-byte identical", async () => {
    for (const [left, right] of synchronizedInfrastructurePairs) {
      const [leftContents, rightContents] = await Promise.all([
        readFile(join(root, left)),
        readFile(join(root, right)),
      ]);
      if (!leftContents.equals(rightContents)) {
        fail(`${left} and ${right} must remain byte-for-byte identical; update both intentionally`);
      }
    }
  });

  it("workspace overrides match the lockfile", () => {
    for (const [name, version] of parseOverrides(workspace)) {
      if (version === "catalog:") continue;
      const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const resolved = lockfile.match(new RegExp(`${escapedName}@[^\\s:]+`, "g")) ?? [];
      if (resolved.length === 0) {
        fail(
          `${name} is overridden to ${version} but is absent from the lockfile; the override is removable`,
        );
      }
      for (const occurrence of resolved) {
        const resolvedVersion = occurrence.slice(name.length + 1);
        if (resolvedVersion !== version) {
          fail(
            `${name} is overridden to ${version} but the lockfile resolves ${resolvedVersion}; update the lockfile or remove the override`,
          );
        }
      }
    }
  });

  it("packages match the uniform package contracts", async () => {
    for (const directory of packageDirectories) {
      const packageDirectory = join(packagesDirectory, directory);
      const manifest = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
      const typeScriptConfiguration = JSON.parse(
        await readFile(join(packageDirectory, "tsconfig.json"), "utf8"),
      );
      const expectedName = `@zeldrisho/${directory}`;
      if (manifest.name !== expectedName) {
        fail(`${directory}/package.json name must be ${expectedName}, received ${manifest.name}`);
      }
      if (JSON.stringify(manifest.scripts) !== JSON.stringify(expectedScripts)) {
        fail(`${manifest.name} scripts must match the uniform package scripts`);
      }
      if (JSON.stringify(manifest.engines) !== JSON.stringify({ node: ">=24" })) {
        fail(`${manifest.name} engines must require Node >=24`);
      }
      if (
        JSON.stringify(typeScriptConfiguration) !== JSON.stringify(expectedTypeScriptConfiguration)
      ) {
        fail(
          `${manifest.name} tsconfig.json must extend the base config and include src and tests`,
        );
      }
      if (!sameValues(manifest.files ?? [], expectedFiles)) {
        fail(
          `${manifest.name} files must contain only ${expectedFiles.join(", ")}; received ${(manifest.files ?? []).join(", ")}`,
        );
      }
      if (JSON.stringify(manifest.pi?.extensions) !== JSON.stringify(["./src/index.ts"])) {
        fail(`${manifest.name} must expose only ./src/index.ts as its Pi extension`);
      }
      if (!readme.includes(`pi install npm:${manifest.name}`)) {
        fail(`README package catalog is missing the install command for ${manifest.name}`);
      }
    }
  });
});

console.log(`Repository contracts passed for ${packageDirectories.length} packages.`);
