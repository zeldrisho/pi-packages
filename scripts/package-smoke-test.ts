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
import * as childProcess from "node:child_process";

const packageNames = ${JSON.stringify(packageNames)};
for (const packageName of packageNames) {
  const createdProcesses = new Set<number>();
  const originalSpawn = childProcess.spawn;
  const originalSpawnSync = childProcess.spawnSync;
  const originalExec = childProcess.exec;
  const originalExecSync = childProcess.execSync;
  const originalExecFile = childProcess.execFile;
  const originalExecFileSync = childProcess.execFileSync;
  const originalFork = childProcess.fork;

  try {
    childProcess.spawn = function (...args: any[]) {
      const child = originalSpawn.apply(this, args as any);
      if (child.pid) createdProcesses.add(child.pid);
      return child;
    } as any;
    childProcess.spawnSync = function (...args: any[]) {
      const result = originalSpawnSync.apply(this, args as any);
      if (result.pid) createdProcesses.add(result.pid);
      return result;
    } as any;
    childProcess.exec = function (...args: any[]) {
      const child = originalExec.apply(this, args as any);
      if (child.pid) createdProcesses.add(child.pid);
      return child;
    } as any;
    childProcess.execSync = function (...args: any[]) {
      const result = originalExecSync.apply(this, args as any);
      if ((result as any).pid) createdProcesses.add((result as any).pid);
      return result;
    } as any;
    childProcess.execFile = function (...args: any[]) {
      const child = originalExecFile.apply(this, args as any);
      if (child.pid) createdProcesses.add(child.pid);
      return child;
    } as any;
    childProcess.execFileSync = function (...args: any[]) {
      const result = originalExecFileSync.apply(this, args as any);
      if ((result as any).pid) createdProcesses.add((result as any).pid);
      return result;
    } as any;
    childProcess.fork = function (...args: any[]) {
      const child = originalFork.apply(this, args as any);
      if (child.pid) createdProcesses.add(child.pid);
      return child;
    } as any;

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
