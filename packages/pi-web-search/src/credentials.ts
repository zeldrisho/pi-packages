import { open } from "node:fs/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

export type ApiKeySource = "environment" | "workspace .env" | "agent .env";

export interface ResolvedApiKey {
  key: string;
  /** Where the key was found; only the source is ever reported, never the value. */
  source: ApiKeySource;
}

export type ApiKeyName = "BRAVE_SEARCH_API_KEY" | "BRAVE_ANSWERS_API_KEY";

const MAX_DOT_ENV_BYTES = 64 * 1024;

/**
 * Extracts the Brave API key from untrusted `.env` text.
 *
 * Only the extracted value is used; file contents are never echoed into
 * errors or tool output.
 */
export function extractKeyValue(
  text: string,
  keyName: ApiKeyName = "BRAVE_SEARCH_API_KEY",
): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const match =
      keyName === "BRAVE_SEARCH_API_KEY"
        ? line.match(/^\s*BRAVE_SEARCH_API_KEY\s*=\s*(.*)$/)
        : line.match(/^\s*BRAVE_ANSWERS_API_KEY\s*=\s*(.*)$/);

    if (!match) continue;
    let value = match[1].trim();

    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }

    return value || undefined;
  }

  return undefined;
}

/**
 * Reads and extracts the Brave API key from a .env file.
 *
 * @param path - Path to the .env file
 * @returns The extracted API key or undefined if file cannot be read or key is not found
 */
async function readDotEnvKey(path: string, keyName: ApiKeyName): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(MAX_DOT_ENV_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, MAX_DOT_ENV_BYTES, 0);

    return extractKeyValue(buffer.toString("utf8", 0, bytesRead), keyName);
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Resolves the Brave API key without exposing its value.
 *
 * Resolution order: process environment, workspace `.env`, agent-global `.env`.
 *
 * @param cwd - The workspace directory whose `.env` is consulted second
 * @returns The key and its source, or `undefined` when no source provides one
 */
export async function resolveApiKey(
  cwd: string,
  keyName: ApiKeyName = "BRAVE_SEARCH_API_KEY",
): Promise<ResolvedApiKey | undefined> {
  const fromEnvironment = process.env[keyName];

  if (fromEnvironment) return { key: fromEnvironment, source: "environment" };

  const fromWorkspace = await readDotEnvKey(join(cwd, ".env"), keyName);

  if (fromWorkspace) return { key: fromWorkspace, source: "workspace .env" };

  const fromAgent = await readDotEnvKey(join(getAgentDir(), ".env"), keyName);

  if (fromAgent) return { key: fromAgent, source: "agent .env" };

  return undefined;
}
