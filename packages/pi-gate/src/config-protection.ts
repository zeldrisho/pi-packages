import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export const CONFIG_CHANGE_REASON = "pi-gate: gate config change requires approval";

const CONFIG_NAMES = ["gate.json", "pi-gate.json"] as const;

function configDirectory(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function canonicalizeWithExistingParent(path: string): string {
  const absolute = resolve(path);

  if (existsSync(absolute)) return realpathSync(absolute);

  const tail: string[] = [];
  let parent = absolute;

  while (!existsSync(parent)) {
    const next = dirname(parent);

    if (next === parent) return absolute;
    tail.unshift(basename(parent));
    parent = next;
  }

  return resolve(realpathSync(parent), ...tail);
}

export function protectedConfigPaths(): string[] {
  const directory = configDirectory();

  return CONFIG_NAMES.map((name) => canonicalizeWithExistingParent(join(directory, name)));
}

function expandHome(path: string): string {
  if (path === "~") return homedir();

  if (path.startsWith("~/")) return join(homedir(), path.slice(2));

  return path;
}

export function isProtectedConfigPath(inputPath: string): boolean {
  if (inputPath.length === 0) return false;
  const expanded = expandHome(inputPath);

  const candidate = canonicalizeWithExistingParent(
    isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded),
  );

  return protectedConfigPaths().includes(candidate);
}

function homeForm(path: string): string | undefined {
  const home = resolve(homedir());
  const absolute = resolve(path);

  if (absolute === home) return "~";

  if (absolute.startsWith(`${home}/`)) return `~/${absolute.slice(home.length + 1)}`;

  return undefined;
}

function configPathForms(name: (typeof CONFIG_NAMES)[number], canonicalPath: string): string[] {
  const configuredDirectory = configDirectory();
  const logicalPath = resolve(configuredDirectory, name);
  const envDirectory = process.env.PI_CODING_AGENT_DIR;
  const forms = [canonicalPath, logicalPath];
  const homeForms = [homeForm(canonicalPath), homeForm(logicalPath)];
  forms.push(...homeForms.filter((form): form is string => form !== undefined));

  if (envDirectory !== undefined) {
    forms.push(`$PI_CODING_AGENT_DIR/${name}`, `\${PI_CODING_AGENT_DIR}/${name}`);
  }

  return [...new Set(forms)];
}

function configDirectoryForms(canonicalPath: string): string[] {
  const configuredDirectory = configDirectory();
  const logicalDirectory = resolve(configuredDirectory);
  const canonicalDirectory = dirname(canonicalPath);
  const forms = [logicalDirectory, canonicalDirectory];
  const homeForms = [homeForm(logicalDirectory), homeForm(canonicalDirectory)];
  forms.push(...homeForms.filter((form): form is string => form !== undefined));

  if (process.env.PI_CODING_AGENT_DIR !== undefined) {
    forms.push("$PI_CODING_AGENT_DIR", "${PI_CODING_AGENT_DIR}");
  }

  return [...new Set(forms)];
}

function commandContainsPath(command: string, path: string): boolean {
  return command.includes(path);
}

export function bashTouchesConfig(command: string): boolean {
  const paths = protectedConfigPaths();
  const pathForms = CONFIG_NAMES.flatMap((name, index) => configPathForms(name, paths[index]!));

  if (pathForms.some((path) => commandContainsPath(command, path))) return true;

  // Relative filenames are guarded only when the command also names the config directory.
  return CONFIG_NAMES.some((name, index) => {
    const refersToDirectory = configDirectoryForms(paths[index]!).some((directory) =>
      commandContainsPath(command, directory),
    );

    return refersToDirectory && commandContainsPath(command, name);
  });
}
