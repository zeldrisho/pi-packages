/** Bounds parsing of provider-generated error text. */
const MAX_QUOTA_ERROR_MESSAGE_CHARS = 16_384;

/** Recognizes a quota error by its top-level type tag. */
function isQuotaError(value: unknown): value is { type: "FreeUsageLimitError" } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "FreeUsageLimitError"
  );
}

/** Recognizes a quota error wrapped in the provider's error field. */
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

/**
 * Parses Retry-After without assuming a daily quota or inventing a reset time.
 * Accepts a delay in seconds (including zero and fractions) or a date.
 *
 * @param now - Current time in milliseconds since the Unix epoch
 * @returns Reset time in epoch milliseconds, or undefined for a missing, invalid,
 *   past, or out-of-range value
 */
export function quotaResetAt(headers: Headers, now: number): number | undefined {
  const value = headers.get("retry-after")?.trim();

  if (!value) return undefined;

  const resetAt = /^\d+(?:\.\d+)?$/u.test(value) ? now + Number(value) * 1_000 : Date.parse(value);

  return Number.isFinite(resetAt) && resetAt >= now && resetAt <= 8.64e15 ? resetAt : undefined;
}

/**
 * Formats an epoch-millisecond reset time using the supplied formatter.
 * Defaults to 24-hour, minute-precision time in the Pi process's locale and timezone,
 * including TZ.
 *
 * @throws {RangeError} If resetAt is invalid or outside the supported date range
 */
export function formatResetTime(
  resetAt: number,
  formatter = new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    timeZoneName: "short",
  }),
): string {
  return formatter.format(resetAt);
}

/**
 * Formats a quota error with the reported reset time, or an unavailable-time notice.
 * Uses "quota exceeded" so Pi recognizes exhausted usage as non-retryable.
 *
 * @param now - Current time in milliseconds since the Unix epoch
 */
export function usageLimitMessage(headers: Headers, now: number): string {
  const resetAt = quotaResetAt(headers, now);

  const reset =
    resetAt === undefined ? "Reset time unavailable." : `Reset time: ${formatResetTime(resetAt)}.`;

  return `OpenCode Free quota exceeded.\n${reset}`;
}
