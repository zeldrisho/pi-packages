import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { normalizeMatchText } from "./rules";

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

export function bashTouchesConfig(command: string): boolean {
  const normalized = normalizeMatchText(command);

  return [...CONFIG_NAMES, ...protectedConfigPaths()].some((path) =>
    normalized.includes(normalizeMatchText(path)),
  );
}
