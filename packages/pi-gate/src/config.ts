import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Action = "prompt" | "block" | "allow";

export interface GateConfig {
  operations: Record<string, Action>;
  promptTimeoutMs: number;
}

const CONFIG_FILE_NAME = "pi-gate.json";
export const CONFIG_SCHEMA_URL =
  "https://raw.githubusercontent.com/zeldrisho/pi-packages/main/packages/pi-gate/config.schema.json";
const ACTIONS: readonly Action[] = ["prompt", "block", "allow"] as const;
export const DEFAULT_PROMPT_TIMEOUT_MS = 30_000;
export const MAX_RULE_COUNT = 1_000;
export const MAX_RULE_PATTERN_LENGTH = 1_024;
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
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/**
 * Returns the full path to the pi-gate configuration file.
 *
 * @returns The absolute path to pi-gate.json
 */
export function configPath(): string {
  return join(agentDir(), CONFIG_FILE_NAME);
}

/**
 * Type guard that checks if an unknown value is a valid Action.
 *
 * @param value - The value to check
 * @returns `true` if the value is one of "prompt", "block", or "allow"
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- type-guard helper intentionally narrows untrusted JSON values at the parse boundary
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
// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- type-guard helper intentionally narrows untrusted JSON values at the parse boundary
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
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validate the optional numeric field at the untrusted JSON boundary before applying range checks
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
export function loadConfig(): GateConfig {
  const path = configPath();
  if (!existsSync(path)) {
    return { operations: {}, promptTimeoutMs: DEFAULT_PROMPT_TIMEOUT_MS };
  }
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return { operations: {}, promptTimeoutMs: DEFAULT_PROMPT_TIMEOUT_MS };
  }
  return parseConfig(content);
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
    writeFileSync(path, content, { encoding: "utf-8", flag: "wx", mode: 0o600 });
  } catch {
    // Best-effort: another process may have created it, or the warning banner
    // will surface that no configuration is active.
  }
}
