import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packagesDirectory = join(root, "packages");
const packageDirectories = (await readdir(packagesDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const readme = await readFile(join(root, "README.md"), "utf8");
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

function sameValues(actual: string[], expected: string[]) {
  const compare = (left: string, right: string) => left.localeCompare(right);
  return JSON.stringify([...actual].sort(compare)) === JSON.stringify([...expected].sort(compare));
}

function fail(message: string): never {
  throw new Error(`Repository contract violation: ${message}`);
}

const documentedDirectories = [...readme.matchAll(/\]\(packages\/([A-Za-z0-9._-]+)\)/g)].map(
  (match) => match[1],
);
if (!sameValues(documentedDirectories, packageDirectories)) {
  fail(
    `README package catalog does not match packages/: documented=${documentedDirectories.sort((left, right) => left.localeCompare(right)).join(",")} actual=${packageDirectories.join(",")}`,
  );
}

for (const [left, right] of synchronizedInfrastructurePairs) {
  const [leftContents, rightContents] = await Promise.all([
    readFile(join(root, left)),
    readFile(join(root, right)),
  ]);
  if (!leftContents.equals(rightContents)) {
    fail(`${left} and ${right} must remain byte-for-byte identical; update both intentionally`);
  }
}

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
  if (JSON.stringify(typeScriptConfiguration) !== JSON.stringify(expectedTypeScriptConfiguration)) {
    fail(`${manifest.name} tsconfig.json must extend the base config and include src and tests`);
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

console.log(`Repository contracts passed for ${packageDirectories.length} packages.`);
