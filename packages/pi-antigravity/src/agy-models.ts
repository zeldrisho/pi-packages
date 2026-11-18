import { runAgy } from "./agy-command.ts";
import type { JsonObject } from "@earendil-works/pi-ai";
import { catalogFromAvailableModels } from "./discovery.ts";
import { FALLBACK_MODELS, type AntigravityModel } from "./models.ts";

/** Parse the CLI's tab-separated model list; ignore progress and malformed lines. */
export function parseAgyModels(output: string): AntigravityModel[] | undefined {
  const models: JsonObject = Object.create(null);
  let count = 0;

  for (const line of output.split(/\r?\n/)) {
    const match = /^([a-z0-9][a-z0-9._-]{0,127})\t([^\t\r\n]{1,200})$/.exec(line);

    if (match === null || /\p{Cc}/u.test(match[2]) || Object.hasOwn(models, match[1])) continue;
    models[match[1]] = { displayName: match[2], supportsImages: false };
    count += 1;

    if (count >= 256) break;
  }

  return catalogFromAvailableModels({ models }, FALLBACK_MODELS);
}

/** Fetch a bounded fallback list from the locally installed CLI. */
export async function fetchAgyModels(signal: AbortSignal): Promise<AntigravityModel[] | undefined> {
  const output = await runAgy("models", { timeout: 5_000, maxBuffer: 64 * 1024, signal });

  return output === undefined ? undefined : parseAgyModels(output);
}
