import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type Action = "prompt" | "block" | "allow";

export interface GateConfig {
  operations: Record<string, Action>;
  promptTimeoutMs: number;
}

export type ConfigLoadStatus = "missing" | "loaded" | "failed";

export interface ConfigLoadResult {
  config: GateConfig;
  status: ConfigLoadStatus;
}

/** Current and legacy filenames in lookup order; both are protected. */
export const CONFIG_NAMES = ["gate.json", "pi-gate.json"] as const;

export const CONFIG_SCHEMA_URL =
  "https://raw.githubusercontent.com/zeldrisho/pi-packages/main/packages/pi-gate/config.schema.json";

const ACTIONS: readonly Action[] = ["prompt", "block", "allow"] as const;

export const DEFAULT_PROMPT_TIMEOUT_MS = 30_000;

export const MAX_RULE_COUNT = 1000;

export const MAX_RULE_PATTERN_LENGTH = 1024;

export const MAX_PROMPT_TIMEOUT_MS = 86_400_000;

const DEFAULT_CONFIG: GateConfig = {
  promptTimeoutMs: DEFAULT_PROMPT_TIMEOUT_MS,
  operations: {
    "rm -rf": "prompt",
    sudo: "prompt",
    "sudo apt update": "allow",
    "chmod 777": "block",
    "corepack enable": "block",
  },
};

/**
 * Returns the directory where pi-gate configuration files are stored.
 *
 * @returns The absolute path to the agent configuration directory
 */
function agentDir(): string {
  return getAgentDir();
}

/**
 * Returns the full path to the pi-gate configuration file.
 *
 * Prefers gate.json, falling back to pi-gate.json only when gate.json is absent.
 *
 * @returns The selected configuration path, or gate.json for first-run creation
 */
export function configPath(): string {
  const [current, legacy] = CONFIG_NAMES;
  const directory = agentDir();
  const path = join(directory, current);

  if (existsSync(path)) return path;

  const legacyPath = join(directory, legacy);

  return existsSync(legacyPath) ? legacyPath : path;
}

/**
 * Type guard that checks if an unknown value is a valid Action.
 *
 * @param value - The value to check
 * @returns `true` if the value is one of "prompt", "block", or "allow"
 */
function isAction(value: unknown): value is Action {
  return (
    typeof value === "string" &&
    // SAFETY: ACTIONS is the source-of-truth tuple of supported action strings; widening
    // it to readonly string[] lets Array.prototype.includes perform a runtime check
    // before the type predicate narrows the value to Action.
    (ACTIONS as readonly string[]).includes(value)
  );
}

/**
 * Type guard that checks if an unknown value is a plain JSON object.
 *
 * @param value - The value to check
 * @returns `true` if the value is a non-null object and not an array
 */
// oxlint-disable-next-line quality/no-unsafe-dictionary-type -- narrow untrusted JSON at the parse boundary
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses the user configuration file. Returns an empty configuration (no
 * rules) when the file is missing, unreadable, malformed, or fails
 * validation; an explicit empty `operations` object is also valid.
 *
 * Invalid entries are skipped so a single bad rule does not disable the
 * entire gate; parsing continues for the remaining rules.
 */
export function parseConfig(content: string): GateConfig {
  const rules: Record<string, Action> = {};
  let acceptedRuleCount = 0;
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch {
    return { operations: rules, promptTimeoutMs: DEFAULT_PROMPT_TIMEOUT_MS };
  }

  if (!isJsonObject(parsed)) {
    return { operations: rules, promptTimeoutMs: DEFAULT_PROMPT_TIMEOUT_MS };
  }

  const configuredTimeout = parsed["promptTimeoutMs"];

  const promptTimeoutMs =
    typeof configuredTimeout === "number" &&
    Number.isInteger(configuredTimeout) &&
    configuredTimeout > 0 &&
    configuredTimeout <= MAX_PROMPT_TIMEOUT_MS
      ? configuredTimeout
      : DEFAULT_PROMPT_TIMEOUT_MS;

  const operations = parsed["operations"];

  if (!isJsonObject(operations)) {
    return { operations: rules, promptTimeoutMs };
  }

  for (const [pattern, action] of Object.entries(operations)) {
    if (acceptedRuleCount >= MAX_RULE_COUNT) break;

    if (pattern.length === 0 || pattern.length > MAX_RULE_PATTERN_LENGTH) continue;

    if (isAction(action)) {
      rules[pattern] = action;
      acceptedRuleCount += 1;
    }
  }

  return { operations: rules, promptTimeoutMs };
}

/**
 * Loads the configuration from disk. Returns an empty configuration when the
 * file is missing; returns the parsed configuration otherwise.
 */
export function loadConfigResult(): ConfigLoadResult {
  const emptyConfig = { operations: {}, promptTimeoutMs: DEFAULT_PROMPT_TIMEOUT_MS };
  const path = configPath();

  if (!existsSync(path)) {
    return { config: emptyConfig, status: "missing" };
  }

  let content: string;

  try {
    content = readFileSync(path, "utf8");
  } catch {
    return { config: emptyConfig, status: "failed" };
  }

  try {
    const parsed: unknown = JSON.parse(content);

    if (!isJsonObject(parsed) || !isJsonObject(parsed["operations"])) {
      return { config: parseConfig(content), status: "failed" };
    }
  } catch {
    return { config: emptyConfig, status: "failed" };
  }

  return { config: parseConfig(content), status: "loaded" };
}

/** Loads the configuration, preserving the historical empty-config fallback. */
export function loadConfig(): GateConfig {
  return loadConfigResult().config;
}

/**
 * Writes the default configuration on first run. Existing configuration files
 * are never overwritten.
 */
export function ensureConfig(): void {
  const path = configPath();

  if (existsSync(path)) return;

  try {
    mkdirSync(agentDir(), { recursive: true });
  } catch {
    return;
  }

  const content = JSON.stringify({ $schema: CONFIG_SCHEMA_URL, ...DEFAULT_CONFIG }, null, 2) + "\n";

  try {
    writeFileSync(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch {
    // Best-effort: another process may have created it, or the warning banner
    // will surface that no configuration is active.
  }
}
