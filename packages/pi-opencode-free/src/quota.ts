/** Bounds parsing of provider-generated error text. */
const MAX_QUOTA_ERROR_MESSAGE_CHARS = 16_384;

function isQuotaError(value: unknown): value is { type: "FreeUsageLimitError" } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "FreeUsageLimitError"
  );
}

function isQuotaEnvelope(value: unknown): value is { error: { type: "FreeUsageLimitError" } } {
  return (
    typeof value === "object" && value !== null && "error" in value && isQuotaError(value.error)
  );
}

/** Recognizes Pi's native JSON error body, not incidental text or nested diagnostic tags. */
export function isFreeUsageLimitMessage(message: string | undefined): boolean {
  if (!message || message.length > MAX_QUOTA_ERROR_MESSAGE_CHARS) return false;
  const start = message.indexOf("{");

  if (start < 0) return false;

  try {
    const body: unknown = JSON.parse(message.slice(start));

    return isQuotaError(body) || isQuotaEnvelope(body);
  } catch {
    return false;
  }
}

/** Parses Retry-After without assuming a daily quota or inventing a reset time. */
export function quotaResetAt(headers: Headers, now: number): number | undefined {
  const value = headers.get("retry-after")?.trim();

  if (!value) return undefined;

  const resetAt = /^\d+(?:\.\d+)?$/u.test(value) ? now + Number(value) * 1_000 : Date.parse(value);

  return Number.isFinite(resetAt) && resetAt >= now && resetAt <= 8.64e15 ? resetAt : undefined;
}

/** Uses the Pi process's locale and timezone, including its standard TZ override. */
export function formatResetTime(
  resetAt: number,
  formatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "long" }),
): string {
  return formatter.format(resetAt);
}

/** Formats a quota error; an absent header must not become a guessed reset. */
export function usageLimitMessage(headers: Headers, now: number): string {
  const resetAt = quotaResetAt(headers, now);

  const reset =
    resetAt === undefined
      ? "Reset time unavailable."
      : `Reported reset: ${formatResetTime(resetAt)}.`;

  return `429: OpenCode Free usage limit reached.\n${reset}`;
}
