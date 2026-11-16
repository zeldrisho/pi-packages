import { createHash } from "node:crypto";
import type { JsonValue } from "@earendil-works/pi-ai";
import { resolveCliVersion, userAgentFor } from "./cli-version.ts";
import { isJsonObject, isJsonText, nonEmptyText, parseJsonValue } from "./json.ts";

/** Default endpoints, tried in order until one answers. */
export const ENDPOINTS = [
  "https://daily-cloudcode-pa.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
] as const;

/** Metadata lookups must fail fast so the next endpoint can be tried. */
const DISCOVERY_TIMEOUT_MS = 8_000;

/**
 * Builds request headers for Antigravity endpoints.
 *
 * @param token - OAuth access token
 * @returns Headers for a JSON request
 */
export async function antigravityHeaders(token: string): Promise<Headers> {
  const override = process.env.PI_ANTIGRAVITY_USER_AGENT?.trim();

  const userAgent =
    override === undefined || override === ""
      ? userAgentFor(await resolveCliVersion()).value
      : override;

  return new Headers({
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": userAgent,
  });
}

/**
 * Derives a deterministic UUID-shaped project id from a seed.
 *
 * @param seed - Stable seed, normally the account email or provider name
 * @returns A UUID-shaped identifier
 */
export function stableProjectId(seed: string): string {
  const bytes = createHash("sha1").update(`antigravity:project:${seed}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Combines the caller's cancellation with a discovery deadline.
 *
 * @param signal - Caller cancellation, when available
 * @param timeoutMs - Deadline for the whole lookup
 * @returns A signal that aborts on either condition
 */
export function discoverySignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);

  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/**
 * Reads a project id from a Cloud Code Assist response.
 *
 * The backend has used several field names for the same value, so every
 * observed shape is checked, including the nested object and list forms.
 *
 * @param value - Parsed response body
 * @returns The project id, or undefined when the response carries none
 */
export function extractProjectId(value: JsonValue | undefined): string | undefined {
  if (!isJsonObject(value)) return undefined;

  for (const key of PROJECT_ID_KEYS) {
    const direct = readProjectId(value[key]);

    if (direct !== undefined) return direct;
  }

  for (const key of PROJECT_LIST_KEYS) {
    const list = value[key];

    if (!Array.isArray(list)) continue;

    for (const entry of list) {
      const nested = readProjectId(entry);

      if (nested !== undefined) return nested;
    }
  }

  return undefined;
}

/** Response fields that have carried a project id directly. */
const PROJECT_ID_KEYS = [
  "antigravityProjectId",
  "projectId",
  "backendProjectId",
  "userDefinedCloudaicompanionProject",
  "cloudaicompanionProject",
  "project",
] as const;

/** Response fields that have carried a list of project ids. */
const PROJECT_LIST_KEYS = ["projects", "projectIds", "cloudaicompanionProjects"] as const;

/**
 * Reads a project id from a direct value, a nested object, or a bare string.
 *
 * @param value - Candidate field value
 * @returns The project id when present
 */
function readProjectId(value: JsonValue | undefined): string | undefined {
  if (isJsonText(value)) return nonEmptyText(value);

  if (!isJsonObject(value)) return undefined;

  return nonEmptyText(value.id);
}

/**
 * Posts a JSON body to one endpoint.
 *
 * @param url - Absolute endpoint URL
 * @param token - OAuth access token
 * @param body - JSON-serializable request body
 * @param signal - Cancellation and deadline
 * @returns The response, without consuming its body
 */
async function postJson(
  url: string,
  token: string,
  body: string,
  signal: AbortSignal,
): Promise<Response> {
  const headers = await antigravityHeaders(token);

  return fetch(url, { method: "POST", headers, body, signal });
}

/**
 * Lists Cloud Code companion projects as a fallback when `loadCodeAssist`
 * returns no project id.
 *
 * @param token - OAuth access token
 * @param signal - Cancellation
 * @returns The first project id the account exposes
 */
async function listCompanionProjects(
  token: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  for (const endpoint of ENDPOINTS) {
    const response = await postJson(
      `${endpoint}/v1internal:listCloudAICompanionProjects`,
      token,
      "{}",
      signal,
    );

    if (!response.ok) continue;

    const projectId = extractProjectId(parseJsonValue(await response.text()));

    if (projectId !== undefined) return projectId;
  }

  return undefined;
}

/**
 * Discovers the Cloud Code Assist project id for an account.
 *
 * `/login` stores the result with the credentials, so requests do not repeat the
 * lookup. Endpoints are tried in order; a discovery failure is fatal because
 * requests cannot be addressed without a project id.
 *
 * @param token - OAuth access token
 * @param signal - Caller cancellation
 * @returns The project id
 * @throws If no endpoint returns a usable project id
 */
export async function discoverProjectId(
  token: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const deadline = discoverySignal(signal, DISCOVERY_TIMEOUT_MS * ENDPOINTS.length);

  for (const endpoint of ENDPOINTS) {
    try {
      const response = await postJson(
        `${endpoint}/v1internal:loadCodeAssist`,
        token,
        JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
        deadline,
      );

      if (response.ok) {
        const projectId = extractProjectId(parseJsonValue(await response.text()));

        if (projectId !== undefined) return projectId;

        const listed = await listCompanionProjects(token, deadline);

        if (listed !== undefined) return listed;
      }
    } catch (error) {
      if (signal?.aborted === true) throw error;
    }
  }

  throw new Error(
    "Antigravity could not resolve a Cloud Code project for this account. Confirm Antigravity access for the account and retry /login antigravity.",
  );
}
