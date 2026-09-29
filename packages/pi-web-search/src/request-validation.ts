import {
  SEARCH_CONTEXT_MAX_QUERY_CHARACTERS,
  SEARCH_CONTEXT_MAX_RESULT_COUNT,
  SEARCH_MAX_DATE_RANGE_CHARACTERS,
  SEARCH_MAX_GOGGLES_CHARACTERS,
  SEARCH_MAX_OFFSET,
  SEARCH_MAX_RESULT_FILTER_CHARACTERS,
  SEARCH_MIN_OFFSET,
  SEARCH_MIN_RESULT_COUNT,
  SEARCH_RESULT_FILTER_VALUES,
  SEARCH_WEB_MAX_QUERY_CHARACTERS,
  SEARCH_WEB_MAX_RESULT_COUNT,
} from "./limits";
import type { ProviderRequestExtras, SearchMode } from "./brave";

const DATE_RANGE_PATTERN = /^\d{4}-\d{2}-\d{2}to\d{4}-\d{2}-\d{2}$/;

const COUNTRY_PATTERN = /^([A-Za-z]{2}|ALL)$/;

/** Validates a query, count, and mode-specific options before contacting Brave. */
export function validateProviderRequest(
  query: string,
  count: number,
  mode: SearchMode,
  extras?: ProviderRequestExtras,
): void {
  if (
    mode === "context" &&
    (extras?.extraSnippets !== undefined ||
      extras?.operators !== undefined ||
      extras?.resultFilter !== undefined ||
      extras?.offset !== undefined ||
      extras?.uiLang !== undefined ||
      extras?.dateRange !== undefined)
  ) {
    throw new Error(
      "The extraSnippets, operators, resultFilter, offset, uiLang, and dateRange options are only supported in web mode.",
    );
  }

  if (mode === "web" && (extras?.threshold !== undefined || extras?.depth !== undefined)) {
    throw new Error("The threshold and depth options are only supported in context mode.");
  }

  const maximumQueryCharacters =
    mode === "context" ? SEARCH_CONTEXT_MAX_QUERY_CHARACTERS : SEARCH_WEB_MAX_QUERY_CHARACTERS;

  if (query.length > maximumQueryCharacters) {
    throw new Error(`Search queries cannot exceed ${maximumQueryCharacters} characters.`);
  }

  const maximumCount =
    mode === "context" ? SEARCH_CONTEXT_MAX_RESULT_COUNT : SEARCH_WEB_MAX_RESULT_COUNT;

  if (!Number.isInteger(count) || count < SEARCH_MIN_RESULT_COUNT || count > maximumCount) {
    throw new Error(
      `Search result count must be an integer between ${SEARCH_MIN_RESULT_COUNT} and ${maximumCount} in ${mode} mode.`,
    );
  }

  if (extras?.country !== undefined && !COUNTRY_PATTERN.test(extras.country)) {
    throw new Error('Search country must be a 2-letter code (e.g. "US") or "ALL".');
  }

  if (extras?.goggles !== undefined) {
    if (!extras.goggles || extras.goggles.length > SEARCH_MAX_GOGGLES_CHARACTERS) {
      throw new Error(
        `Search goggles must be between 1 and ${SEARCH_MAX_GOGGLES_CHARACTERS} characters.`,
      );
    }
  }

  if (extras?.offset !== undefined) {
    if (
      !Number.isInteger(extras.offset) ||
      extras.offset < SEARCH_MIN_OFFSET ||
      extras.offset > SEARCH_MAX_OFFSET
    ) {
      throw new Error(
        `Search offset must be an integer between ${SEARCH_MIN_OFFSET} and ${SEARCH_MAX_OFFSET}.`,
      );
    }
  }

  if (extras?.resultFilter !== undefined) normalizeResultFilter(extras.resultFilter);

  if (extras?.dateRange !== undefined) {
    if (
      extras.dateRange.length > SEARCH_MAX_DATE_RANGE_CHARACTERS ||
      !DATE_RANGE_PATTERN.test(extras.dateRange)
    ) {
      throw new Error(
        "Search dateRange must use YYYY-MM-DDtoYYYY-MM-DD (e.g. 2025-01-01to2025-06-30).",
      );
    }
  }

  if (extras?.uiLang !== undefined && (extras.uiLang.length < 2 || extras.uiLang.length > 20)) {
    throw new Error("Search uiLang must be between 2 and 20 characters (e.g. en-US).");
  }
}

/** Normalizes and validates Brave's comma-separated `result_filter` option. */
export function normalizeResultFilter(value: string): string {
  const values = value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  const unique = [...new Set(values)];
  const allowed = new Set<string>(SEARCH_RESULT_FILTER_VALUES);

  if (
    unique.length === 0 ||
    value.length > SEARCH_MAX_RESULT_FILTER_CHARACTERS ||
    unique.some((item) => !allowed.has(item)) ||
    !unique.includes("web")
  ) {
    throw new Error(
      `Search resultFilter must be a comma-separated list of: ${SEARCH_RESULT_FILTER_VALUES.join(", ")}, and must include "web" (only web results are mapped).`,
    );
  }

  return unique.join(",");
}
