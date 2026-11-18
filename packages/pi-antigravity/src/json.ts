import type { JsonObject, JsonValue } from "@earendil-works/pi-ai";

/**
 * Parses JSON text from a provider response or a stored credential string.
 *
 * @param text - Raw JSON text
 * @returns The parsed JSON value
 * @throws If the text is not valid JSON
 */
export function parseJsonValue(text: string): JsonValue {
  // SAFETY: JSON.parse only ever produces JSON values; the parse error is left to the caller.
  return JSON.parse(text) as JsonValue;
}

/**
 * Reports whether a JSON value is an object.
 *
 * @param value - JSON value from a decoded payload
 * @returns True when the value is a JSON object
 */
// oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON values carry no static shape until decoded
export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reports whether a JSON value is a string.
 *
 * @param value - JSON value from a decoded payload
 * @returns True when the value is a string
 */
// oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON values carry no static shape until decoded
export function isJsonText(value: JsonValue | undefined): value is string {
  return typeof value === "string";
}

/**
 * Reports whether a JSON value is a finite number.
 *
 * @param value - JSON value from a decoded payload
 * @returns True when the value is a usable number
 */
// oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON values carry no static shape until decoded
export function isJsonNumber(value: JsonValue | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Reads a non-empty string field.
 *
 * @param value - JSON value from a decoded payload
 * @returns The string, or undefined when it is empty or not a string
 */
export function nonEmptyText(value: JsonValue | undefined): string | undefined {
  return isJsonText(value) && value.length > 0 ? value : undefined;
}
