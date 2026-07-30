import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const packagesDirectory = join(root, "packages");
const packageDirectories = (await readdir(packagesDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(packagesDirectory, entry.name));
const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-package-smoke-"));
const tarballDirectory = join(temporaryDirectory, "tarballs");
const fixtureDirectory = join(temporaryDirectory, "fixture");

function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

try {
  await Promise.all([
    mkdir(tarballDirectory, { recursive: true }),
    mkdir(fixtureDirectory, { recursive: true }),
  ]);

  const dependencies: Record<string, string> = {};
  const packageNames: string[] = [];
  for (const directory of packageDirectories) {
    const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    run("vp", ["pm", "pack", "--", "--pack-destination", tarballDirectory], directory);
    const prefix = `${manifest.name.replace(/^@/, "").replace("/", "-")}-${manifest.version}`;
    const tarball = (await readdir(tarballDirectory)).find(
      (file) => file.startsWith(prefix) && file.endsWith(".tgz"),
    );
    if (!tarball) throw new Error(`No tarball was produced for ${manifest.name}`);
    dependencies[manifest.name] = `file:${join(tarballDirectory, tarball)}`;
    packageNames.push(manifest.name);
  }

  Object.assign(dependencies, {
    "@earendil-works/pi-ai": "^0.80.10",
    "@earendil-works/pi-coding-agent": "^0.80.10",
    "@earendil-works/pi-tui": "^0.80.10",
    typebox: "^1.1.24",
  });
  await writeFile(
    join(fixtureDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "pi-package-smoke-fixture",
        private: true,
        type: "module",
        dependencies,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(fixtureDirectory, "smoke.ts"),
    `import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const packageNames = ${JSON.stringify(packageNames)};
const childProcessIds = () =>
  new Set(
    process
      ._getActiveHandles()
      .filter((handle) => handle?.constructor?.name === "ChildProcess")
      .map((handle) => handle.pid)
      .filter((pid) => typeof pid === "number"),
  );
for (const packageName of packageNames) {
  const childrenBeforeLoad = childProcessIds();
  const packageDirectory = join(process.cwd(), "node_modules", ...packageName.split("/"));
  const manifest = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
  if (JSON.stringify(manifest.pi?.extensions) !== JSON.stringify(["./src/index.ts"])) {
    throw new Error(\`Invalid Pi extension manifest for \${packageName}\`);
  }
  const extensionPath = join(packageDirectory, manifest.pi.extensions[0]);
  const loaded = await discoverAndLoadExtensions(
    [extensionPath],
    process.cwd(),
    join(process.cwd(), ".agent"),
  );
  if (loaded.errors.length > 0) {
    throw new Error(\`Failed to load \${packageName}: \${JSON.stringify(loaded.errors)}\`);
  }
  const extension = loaded.extensions.find((entry) => entry.resolvedPath === extensionPath);
  const registrations =
    (extension?.handlers.size ?? 0) +
    (extension?.tools.size ?? 0) +
    (extension?.commands.size ?? 0);
  if (!extension || registrations === 0) {
    throw new Error(\`\${packageName} did not register a Pi extension\`);
  }
  await new Promise((resolve) => setImmediate(resolve));
  const unexpectedChildren = [...childProcessIds()].filter((pid) => !childrenBeforeLoad.has(pid));
  if (unexpectedChildren.length > 0) {
    throw new Error(
      \`\${packageName} started child processes while loading: \${unexpectedChildren.join(", ")}\`,
    );
  }
}
`,
  );

  run("vp", ["install", "--ignore-scripts", "--shamefully-hoist"], fixtureDirectory);
  run("vp", ["exec", "node", "smoke.ts"], fixtureDirectory);
  console.log(`Smoke-tested ${packageNames.length} packed Pi extensions.`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
