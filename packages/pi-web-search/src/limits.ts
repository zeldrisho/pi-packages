/** Default number of search results to return. */
export const SEARCH_DEFAULT_RESULT_COUNT = 5;

/** Minimum allowed result count. */
export const SEARCH_MIN_RESULT_COUNT = 1;

/**
 * Maximum allowed result count at the schema level (superset of both modes).
 * Web mode is limited to {@link SEARCH_WEB_MAX_RESULT_COUNT} and context mode
 * to {@link SEARCH_CONTEXT_MAX_RESULT_COUNT}; the tighter per-mode limit is
 * enforced at runtime because the provider rejects union schemas.
 */
export const SEARCH_MAX_RESULT_COUNT = 50;

/** Maximum result count for web-mode search (Brave allows 1-20). */
export const SEARCH_WEB_MAX_RESULT_COUNT = 20;

/** Maximum result count for context-mode search (Brave allows 1-50). */
export const SEARCH_CONTEXT_MAX_RESULT_COUNT = 50;

/** Maximum query length for context-based search (characters). */
export const SEARCH_CONTEXT_MAX_QUERY_CHARACTERS = 400;

/** Maximum query length for web search (characters). */
export const SEARCH_WEB_MAX_QUERY_CHARACTERS = 400;

/** Minimum allowed language code length (characters). */
export const SEARCH_MIN_LANGUAGE_CHARACTERS = 2;

/** Maximum allowed language code length (characters). */
export const SEARCH_MAX_LANGUAGE_CHARACTERS = 20;

/** Minimum allowed country code length (characters). */
export const SEARCH_MIN_COUNTRY_CHARACTERS = 2;

/** Maximum allowed country code length (characters; 3 supports the `ALL` value). */
export const SEARCH_MAX_COUNTRY_CHARACTERS = 3;

/** Minimum result offset for pagination. */
export const SEARCH_MIN_OFFSET = 0;

/** Maximum result offset for pagination (Brave allows 0-9). */
export const SEARCH_MAX_OFFSET = 9;

/** Maximum Goggle definition or URL length (characters). */
export const SEARCH_MAX_GOGGLES_CHARACTERS = 2000;

/** Maximum result-filter list length (characters). */
export const SEARCH_MAX_RESULT_FILTER_CHARACTERS = 64;

/** Maximum custom date-range length (`YYYY-MM-DDtoYYYY-MM-DD`, characters). */
export const SEARCH_MAX_DATE_RANGE_CHARACTERS = 22;

/** Result types accepted by Brave's `result_filter` parameter. */
export const SEARCH_RESULT_FILTER_VALUES = [
  "discussions",
  "faq",
  "infobox",
  "news",
  "query",
  "videos",
  "web",
  "locations",
] as const;
