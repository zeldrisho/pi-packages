import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "./..");

const packagesDirectory = join(root, "packages");

const packageDirectories = (await readdir(packagesDirectory, { withFileTypes: true }))
  .filter(
    (entry) =>
      entry.isDirectory() && existsSync(join(packagesDirectory, entry.name, "package.json")),
  )
  .map((entry) => join(packagesDirectory, entry.name));

const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-package-smoke-"));

const tarballDirectory = join(temporaryDirectory, "tarballs");

const fixtureDirectory = join(temporaryDirectory, "fixture");

const piEcosystemDependencies = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
] as const;

const smokeDependencies = [...piEcosystemDependencies, "typebox"] as const;

/**
 * Resolves the dependency version used by the smoke-test fixture.
 *
 * @param packageName - The dependency package name
 * @returns The dependency version, or `latest` for configured Pi ecosystem dependencies
 * @throws If a package manifest cannot be read or no valid installed version is found
 */
async function smokeDependencyVersion(packageName: string): Promise<string> {
  if (
    process.env.PI_SMOKE_DEPENDENCIES === "latest" &&
    piEcosystemDependencies.some((dependency) => dependency === packageName)
  ) {
    return "latest";
  }

  for (const packageDirectory of packageDirectories) {
    try {
      const manifestPath = join(
        packageDirectory,
        "node_modules",
        ...packageName.split("/"),
        "package.json",
      );

      // SAFETY: manifests are produced by `vp pm pack`; we only read the `version`
      // field, which is a semver string when present.
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { version?: string };

      if (manifest.version && /^\d+\.\d+\.\d+/.test(manifest.version)) {
        return manifest.version;
      }
    } catch (error) {
      // SAFETY: a read failure other than a missing manifest file is unexpected and must
      // propagate; we only swallow ENOENT (the package is simply not installed).
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  throw new Error(`Unable to derive the installed version for ${packageName}`);
}

/**
 * Executes a command synchronously in the specified working directory.
 *
 * Writes captured output and throws an error when the command exits unsuccessfully.
 *
 * @param command - The command to execute
 * @param args - Arguments passed to the command
 * @param cwd - Working directory for the command
 */
function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });

  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }

  return result.stdout;
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

    const entries = run("tar", ["-tzf", join(tarballDirectory, tarball)], directory)
      .trim()
      .split("\n");

    const allowed = ["package.json", "README.md", "LICENSE", ...manifest.files];

    for (const entry of entries) {
      const path = entry.replace(/^package\//, "");

      if (
        !entry.startsWith("package/") ||
        path.split("/").some((part) => part === ".." || part === ".") ||
        !allowed.some((name: string) => path === name || path.startsWith(`${name}/`))
      ) {
        throw new Error(`Unexpected tarball entry for ${manifest.name}: ${entry}`);
      }
    }

    for (const name of allowed) {
      if (
        !entries.some(
          (entry) => entry === `package/${name}` || entry.startsWith(`package/${name}/`),
        )
      ) {
        throw new Error(`Missing tarball entry for ${manifest.name}: ${name}`);
      }
    }

    dependencies[manifest.name] = `file:${join(tarballDirectory, tarball)}`;
    packageNames.push(manifest.name);
  }

  for (const packageName of smokeDependencies) {
    dependencies[packageName] = await smokeDependencyVersion(packageName);
  }

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
    join(fixtureDirectory, "spawns-child.ts"),
    `import { execFile } from "node:child_process";
import { promisify } from "node:util";

export default function (pi) {
  pi.on("session_start", () => {});
  void promisify(execFile)(process.execPath, ["-e", ""]);
}
`,
  );
  await writeFile(
    join(fixtureDirectory, "smoke.ts"),
    `import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import childProcess from "node:child_process";

const processMethods = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"];
const packageNames = ${JSON.stringify(packageNames)};
const agentDirectory = join(process.cwd(), ".agent");
process.env.PI_CODING_AGENT_DIR = agentDirectory;
for (const packageName of packageNames) {
  const packageDirectory = join(process.cwd(), "node_modules", ...packageName.split("/"));
  const manifest = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
  if (Array.isArray(manifest.pi?.themes)) {
    if (JSON.stringify(manifest.pi.themes) !== JSON.stringify(["./themes"])) {
      throw new Error(\`Invalid Pi theme manifest for \${packageName}\`);
    }
    const themeDirectory = join(packageDirectory, "themes");
    const themeFiles = (await readdir(themeDirectory)).filter((file) => file.endsWith(".json"));
    if (themeFiles.length === 0) {
      throw new Error(\`\${packageName} did not package any themes\`);
    }
    for (const themeFile of themeFiles) {
      const theme = JSON.parse(await readFile(join(themeDirectory, themeFile), "utf8"));
      if (typeof theme.name !== "string" || typeof theme.colors !== "object") {
        throw new Error(\`\${packageName} has an invalid theme: \${themeFile}\`);
      }
    }
    continue;
  }
  if (JSON.stringify(manifest.pi?.extensions) !== JSON.stringify(["./src/index.ts"])) {
    throw new Error(\`Invalid Pi extension manifest for \${packageName}\`);
  }

  await checkExtension(packageName, join(packageDirectory, manifest.pi.extensions[0]));
}

await assert.rejects(
  checkExtension("spawns-child", join(process.cwd(), "spawns-child.ts")),
  /spawns-child started child processes while loading:/,
);

async function checkExtension(packageName: string, extensionPath: string) {
  try {
    const processSpies = processMethods.map((name) => ({ name, spy: mock.method(childProcess, name) }));
    // Node's custom promisifier can bypass the exported execFile and spawn methods.
    const childSpawn = mock.method(childProcess.ChildProcess.prototype, "spawn");
    syncBuiltinESMExports();

    const loaded = await discoverAndLoadExtensions([extensionPath], process.cwd(), agentDirectory);
    if (loaded.errors.length > 0) {
      throw new Error(\`Failed to load \${packageName}: \${JSON.stringify(loaded.errors)}\`);
    }
    const extension = loaded.extensions.find((entry) => entry.resolvedPath === extensionPath);
    const registrations =
      (extension?.handlers.size ?? 0) +
      (extension?.tools.size ?? 0) +
      (extension?.commands.size ?? 0) +
      loaded.runtime.pendingProviderRegistrations.filter((entry) => entry.extensionPath === extension?.path).length +
      loaded.runtime.pendingNativeProviderRegistrations.filter((entry) => entry.extensionPath === extension?.path).length;
    if (!extension) {
      throw new Error(\`\${packageName} did not load as a Pi extension\`);
    }
    if (registrations === 0) {
      throw new Error(\`\${packageName} did not register a Pi extension\`);
    }
    await new Promise((resolve) => setImmediate(resolve));

    const called = processSpies.filter(({ spy }) => spy.mock.callCount() > 0).map(({ name }) => name);
    if (childSpawn.mock.callCount() > 0) called.push("ChildProcess.prototype.spawn");
    if (called.length > 0) {
      throw new Error(\`\${packageName} started child processes while loading: \${called.join(", ")}\`);
    }
  } finally {
    mock.reset();
    syncBuiltinESMExports();
  }
}
`,
  );

  run("vp", ["install", "--ignore-scripts", "--shamefully-hoist"], fixtureDirectory);
  run("vp", ["exec", "node", "smoke.ts"], fixtureDirectory);
  console.log(`Smoke-tested ${packageNames.length} packed Pi packages.`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
