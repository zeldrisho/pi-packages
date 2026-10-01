import { ExpiringLruCache } from "./cache";
import type { CompleteDocument } from "./content";
import { fetchCompleteDocument, type FetchRemoteDependencies } from "./fetch";
import { InflightCoalescer } from "./inflight";

const CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

const LLMS_TXT_MIN_MARKDOWN_CHARACTERS = 200;

const encoder = new TextEncoder();

function safeUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/**
 * Builds candidate `/llms.txt` URLs for a page: the site-root index plus each ancestor
 * directory index up to `MAX_LLMS_TXT_DIRECTORY_DEPTH` levels deep, mirroring sites that
 * publish per-section indexes (for example `developers.cloudflare.com/r2/llms.txt`).
 * Returns them ordered shallow → deep, and an empty list for non-HTTP(S) targets or when
 * the page itself is already a `llms.txt` path, so a fallback never retries itself.
 */
function isGitHubLikeHost(hostname: string): boolean {
  return (
    hostname === "github.com" ||
    hostname === "raw.githubusercontent.com" ||
    hostname === "gist.github.com" ||
    hostname === "gist.githubusercontent.com"
  );
}

/**
 * Build candidate /llms.txt URLs to probe for a given page.
 *
 * Generates a list of potential /llms.txt index URLs by checking the site root
 * and ancestor directories up to a maximum depth. Returns URLs ordered from
 * shallowest to deepest.
 *
 * @param rawUrl - The original page URL
 * @returns Array of candidate /llms.txt URLs to probe (empty for non-HTTP/S or GitHub)
 */
export function buildLlmsTxtCandidateUrls(rawUrl: string): URL[] {
  try {
    const url = new URL(rawUrl);

    if (url.protocol !== "https:" && url.protocol !== "http:") return [];

    if (isGitHubLikeHost(url.hostname)) return [];

    if (url.pathname === "/llms.txt" || url.pathname.endsWith("/llms.txt")) return [];

    // Ancestor directories only, one level deep: for `/r2/buckets/x` probe
    // `/llms.txt` and `/r2/llms.txt`, never deeper. A trailing slash marks the final
    // segment as a directory itself, so `/r2/` still probes `/r2/llms.txt`.
    const trimmedDirectory = url.pathname.endsWith("/")
      ? url.pathname
      : url.pathname.replace(/\/[^/]*$/, "/");

    const directories = ["/"];
    const parts = trimmedDirectory.split("/").filter(Boolean);

    for (let depth = 1; depth <= Math.min(MAX_LLMS_TXT_DIRECTORY_DEPTH, parts.length); depth += 1) {
      directories.push(`/${parts.slice(0, depth).join("/")}/`);
    }

    return directories.map((pathname) => {
      const candidate = new URL(url.origin);
      candidate.pathname = `${pathname}llms.txt`;

      return candidate;
    });
  } catch {
    return [];
  }
}

function isLowQualityDocument(document: CompleteDocument): boolean {
  // Sparse extraction alone is not proof of an empty app shell: server-rendered pages
  // may include useful content in streaming/framework markup that article extraction
  // does not fully recognize. Keep that page rather than replacing it with a site index.
  const diagnostics = document.extractionDiagnostics;

  return Boolean(
    diagnostics?.javascriptRequired || diagnostics?.botWall || diagnostics?.consentInterstitial,
  );
}

/** A probed `/llms.txt` outcome for one candidate URL; an absent document means "unavailable". */
interface LlmsTxtProbe {
  document?: CompleteDocument;
  expires: number;
}

const MAX_LLMS_TXT_PROBE_ENTRIES = 512;

/** Deepest ancestor-directory `/llms.txt` probed, e.g. `/r2/x/y` probes `/r2/llms.txt`. */
const MAX_LLMS_TXT_DIRECTORY_DEPTH = 1;

const llmsTxtProbes = new ExpiringLruCache<string, LlmsTxtProbe>(
  MAX_LLMS_TXT_PROBE_ENTRIES,
  8 * 1024 * 1024,
  (probe) => encoder.encode(JSON.stringify(probe)).byteLength,
);

const llmsTxtProbeRequests = new InflightCoalescer<string, LlmsTxtProbe>(
  MAX_LLMS_TXT_PROBE_ENTRIES,
);

function rememberLlmsTxtProbe(origin: string, probe: LlmsTxtProbe): void {
  llmsTxtProbes.set(origin, probe, probe.expires);
}

function isUsableLlmsTxtIndex(document: CompleteDocument): boolean {
  return (
    document.extractor === "raw" &&
    !document.shellSuspected &&
    document.markdown.length >= LLMS_TXT_MIN_MARKDOWN_CHARACTERS
  );
}

function toAbsoluteUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/**
 * Returns the deepest usable `/llms.txt` index among the candidates, probing each
 * uncached candidate at most once per TTL window (negative results are cached too).
 * Any failure is treated as absence so a missing index can never degrade the primary
 * fetch.
 */
async function ensureLlmsTxtIndex(
  candidates: URL[],
  signal: AbortSignal | undefined,
  dependencies: FetchRemoteDependencies,
): Promise<{ url: string; document: CompleteDocument } | undefined> {
  const documents = await Promise.all(
    candidates.map((candidate) => probeUsableRawText(candidate, signal, dependencies)),
  );

  // Candidates are ordered shallow → deep; prefer the deepest usable index because a
  // section index is the more relevant table of contents for the requested page.
  for (let depth = documents.length - 1; depth >= 0; depth -= 1) {
    const document = documents[depth];

    if (document) return { url: candidates[depth].href, document };
  }

  return undefined;
}

/**
 * Probes one URL at most once per TTL window (negative results are cached too) and
 * returns its document only when it is usable raw text. Used for `/llms.txt` indexes
 * and for advertised Markdown versions of a page. Any failure is treated as absence so
 * a missing resource can never degrade the primary fetch.
 */
async function probeUsableRawText(
  candidate: URL,
  signal: AbortSignal | undefined,
  dependencies: FetchRemoteDependencies,
): Promise<CompleteDocument | undefined> {
  const cached = llmsTxtProbes.get(candidate.href);

  if (cached) return cached.document;

  const probe = await llmsTxtProbeRequests.run(
    candidate.href,
    async (sharedSignal) => {
      const existing = llmsTxtProbes.get(candidate.href);

      if (existing) return existing;

      try {
        const document = await fetchCompleteDocument(
          candidate.toString(),
          sharedSignal,
          dependencies,
        );

        const available = isUsableLlmsTxtIndex(document) ? document : undefined;
        const result = { document: available, expires: Date.now() + CACHE_TTL_MS };
        rememberLlmsTxtProbe(candidate.href, result);

        return result;
      } catch (error) {
        if (sharedSignal?.aborted) throw error;
        const result = { expires: Date.now() + CACHE_TTL_MS };
        rememberLlmsTxtProbe(candidate.href, result);

        return result;
      }
    },
    signal,
    "web_fetch was cancelled.",
  );

  return probe.document;
}

/**
 * Validates that a candidate URL is safe to probe: must use HTTP(S) and match the primary
 * page's origin. This prevents SSRF-like issues where a fetched page could embed meta tags
 * pointing to arbitrary/internal/cross-origin URLs.
 */
function isSafeToProbe(candidate: URL | undefined, primaryUrl: string): boolean {
  if (!candidate) return false;
  const protocol = candidate.protocol;

  if (protocol !== "http:" && protocol !== "https:") return false;
  const primaryParsed = safeUrl(primaryUrl);

  if (!primaryParsed) return false;

  return candidate.origin === primaryParsed.origin;
}

/**
 * Fetches a page with llms.txt awareness:
 *
 * - Probes the site's `/llms.txt` index once per origin per TTL window, in parallel with
 *   the primary fetch, so later calls can advertise it.
 * - Serves the index instead of the page when the page looks like an app shell or carries
 *   too little readable text.
 * - Otherwise annotates the page with the index URL so agents can discover sibling pages.
 *
 * A missing or useless index can never degrade the primary fetch.
 */
export async function fetchDocumentWithLlmsTxtSupport(
  rawUrl: string,
  signal: AbortSignal | undefined,
  dependencies: FetchRemoteDependencies,
): Promise<CompleteDocument> {
  try {
    if (isGitHubLikeHost(new URL(rawUrl).hostname)) {
      return fetchCompleteDocument(rawUrl, signal, dependencies);
    }
  } catch {
    // Invalid URL falls through to fetchCompleteDocument which will throw.
  }

  const candidates = buildLlmsTxtCandidateUrls(rawUrl);

  const [primary, blindIndex] = await Promise.all([
    fetchCompleteDocument(rawUrl, signal, dependencies, true),
    candidates.length > 0
      ? ensureLlmsTxtIndex(candidates, signal, dependencies)
      : Promise.resolve(undefined),
  ]);

  // A `describedby` advertisement names the covering index authoritatively per
  // llmstxt.org v2, so it outranks the blind root/section probes whenever usable.
  let index = blindIndex;

  if (primary.llmsTxtDescribedBy) {
    const describedBy = toAbsoluteUrl(primary.llmsTxtDescribedBy);

    const described =
      describedBy && isSafeToProbe(describedBy, primary.url)
        ? await probeUsableRawText(describedBy, signal, dependencies)
        : undefined;

    if (described && describedBy) index = { url: describedBy.href, document: described };
  }

  if (isLowQualityDocument(primary) || !primary.markdown.trim()) {
    // The page's own advertised Markdown version is strictly better than an index.
    const markdownAlternate = primary.markdownAlternateUrl
      ? toAbsoluteUrl(primary.markdownAlternateUrl)
      : undefined;

    const alternate =
      markdownAlternate && isSafeToProbe(markdownAlternate, primary.url)
        ? await probeUsableRawText(markdownAlternate, signal, dependencies)
        : undefined;

    if (alternate && markdownAlternate) {
      return { ...alternate, markdownAlternateFallback: true };
    }

    if (index) return { ...index.document, llmsTxtFallback: true };
  } else if (index) {
    return { ...primary, llmsTxtIndexUrl: index.url };
  }

  if (!primary.markdown.trim()) {
    throw new Error("web_fetch: Page has no extractable content.");
  }

  return primary;
}
