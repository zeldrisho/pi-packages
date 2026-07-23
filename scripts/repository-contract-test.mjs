import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packagesDirectory = join(root, "packages");
const packageDirectories = (await readdir(packagesDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const readme = await readFile(join(root, "README.md"), "utf8");
const releaseConfig = JSON.parse(await readFile(join(root, "release-please-config.json"), "utf8"));
const expectedFiles = ["src", "README.md", "CHANGELOG.md", "LICENSE"];
const synchronizedInfrastructurePairs = [
  ["packages/pi-web-fetch/src/cache.ts", "packages/pi-web-search/src/cache.ts"],
  ["packages/pi-web-fetch/src/inflight.ts", "packages/pi-web-search/src/inflight.ts"],
  ["packages/pi-web-fetch/src/render.ts", "packages/pi-web-search/src/render.ts"],
];

function sameValues(actual, expected) {
  const compare = (left, right) => left.localeCompare(right);
  return JSON.stringify([...actual].sort(compare)) === JSON.stringify([...expected].sort(compare));
}

function fail(message) {
  throw new Error(`Repository contract violation: ${message}`);
}

const documentedDirectories = [...readme.matchAll(/\]\(packages\/([A-Za-z0-9._-]+)\)/g)].map(
  (match) => match[1],
);
if (!sameValues(documentedDirectories, packageDirectories)) {
  fail(
    `README package catalog does not match packages/: documented=${documentedDirectories.sort().join(",")} actual=${packageDirectories.join(",")}`,
  );
}

const configuredPackages = Object.keys(releaseConfig.packages ?? {})
  .map((path) => path.replace(/^packages\//, ""))
  .sort();
if (!sameValues(configuredPackages, packageDirectories)) {
  fail(
    `Release Please package catalog does not match packages/: configured=${configuredPackages.join(",")} actual=${packageDirectories.join(",")}`,
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
  const manifest = JSON.parse(
    await readFile(join(packagesDirectory, directory, "package.json"), "utf8"),
  );
  const expectedName = `@zeldrisho/${directory}`;
  if (manifest.name !== expectedName) {
    fail(`${directory}/package.json name must be ${expectedName}, received ${manifest.name}`);
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
