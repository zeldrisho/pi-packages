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
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { version?: unknown };
      if (typeof manifest.version === "string" && /^\d+\.\d+\.\d+/.test(manifest.version)) {
        return manifest.version;
      }
    } catch (error) {
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
    join(fixtureDirectory, "smoke.ts"),
    `import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import childProcess from "node:child_process";

const packageNames = ${JSON.stringify(packageNames)};
for (const packageName of packageNames) {
  const createdProcesses = new Set<string>();
  const originalSpawn = childProcess.spawn;
  const originalSpawnSync = childProcess.spawnSync;
  const originalExec = childProcess.exec;
  const originalExecSync = childProcess.execSync;
  const originalExecFile = childProcess.execFile;
  const originalExecFileSync = childProcess.execFileSync;
  const originalFork = childProcess.fork;

  try {
    childProcess.spawn = function (...args: any[]) {
      createdProcesses.add("spawn");
      return originalSpawn.apply(this, args as any);
    } as any;
    childProcess.spawnSync = function (...args: any[]) {
      createdProcesses.add("spawnSync");
      return originalSpawnSync.apply(this, args as any);
    } as any;
    childProcess.exec = function (...args: any[]) {
      createdProcesses.add("exec");
      return originalExec.apply(this, args as any);
    } as any;
    childProcess.execSync = function (...args: any[]) {
      createdProcesses.add("execSync");
      return originalExecSync.apply(this, args as any);
    } as any;
    childProcess.execFile = function (...args: any[]) {
      createdProcesses.add("execFile");
      return originalExecFile.apply(this, args as any);
    } as any;
    childProcess.execFileSync = function (...args: any[]) {
      createdProcesses.add("execFileSync");
      return originalExecFileSync.apply(this, args as any);
    } as any;
    childProcess.fork = function (...args: any[]) {
      createdProcesses.add("fork");
      return originalFork.apply(this, args as any);
    } as any;
    syncBuiltinESMExports();

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

    if (createdProcesses.size > 0) {
      throw new Error(
        \`\${packageName} started child processes while loading: \${[...createdProcesses].join(", ")}\`,
      );
    }
  } finally {
    childProcess.spawn = originalSpawn;
    childProcess.spawnSync = originalSpawnSync;
    childProcess.exec = originalExec;
    childProcess.execSync = originalExecSync;
    childProcess.execFile = originalExecFile;
    childProcess.execFileSync = originalExecFileSync;
    childProcess.fork = originalFork;
    syncBuiltinESMExports();
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
