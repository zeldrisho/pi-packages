import { ExpiringLruCache } from "../cache";
import type { CompleteDocument } from "../document/content.ts";
import {
  ChallengeBlockedError,
  fetchCompleteDocument,
  type FetchRemoteDependencies,
} from "./fetch.ts";
import { InflightCoalescer } from "../inflight";
import { validateRemoteUrl } from "../network/network-policy.ts";

function restrictOrigin(
  dependencies: FetchRemoteDependencies,
  origin: string,
): FetchRemoteDependencies {
  const validate = dependencies.validateUrl ?? validateRemoteUrl;

  return {
    ...dependencies,
    solveAnubisChallenges: false,
    solveAwsWafChallenges: false,
    validateUrl: async (value) => {
      const url = value instanceof URL ? value : new URL(value);

      if (url.origin !== origin || url.username || url.password)
        throw new Error("Cross-origin fallback redirect refused.");

      return validate(value);
    },
  };
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

/** Bounds parallel index probes while allowing substantially deeper paths than two levels. */
const MAX_LLMS_TXT_CANDIDATES = 16;

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
 * Builds candidate `/llms.txt` URLs for a page: the site-root index plus every ancestor
 * directory index, mirroring sites that publish per-section indexes. Returns them ordered
 * shallow → deep, and an empty list for non-HTTP(S) targets or when the page itself is
 * already a `llms.txt` path, so a fallback never retries itself.
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

    // A trailing slash marks the final segment as a directory itself, so `/r2/`
    // probes `/r2/llms.txt`.
    const trimmedDirectory = url.pathname.endsWith("/")
      ? url.pathname
      : url.pathname.replace(/\/[^/]*$/, "/");

    const directories = ["/"];
    const parts = trimmedDirectory.split("/").filter(Boolean);

    for (let depth = 1; depth <= parts.length; depth += 1) {
      directories.push(`/${parts.slice(0, depth).join("/")}/`);
    }

    const selectedDirectories =
      directories.length <= MAX_LLMS_TXT_CANDIDATES
        ? directories
        : [directories[0], ...directories.slice(-(MAX_LLMS_TXT_CANDIDATES - 1))];

    return selectedDirectories.map((pathname) => {
      const candidate = new URL(url.origin);
      candidate.pathname = `${pathname}llms.txt`;

      return candidate;
    });
  } catch {
    return [];
  }
}

/** Returns documented Markdown endpoints only for known documentation routes. */
export function documentationMarkdownUrl(value: string): URL | undefined {
  const url = safeUrl(value);

  if (!url || url.protocol !== "https:" || url.username || url.password || url.port) return;

  if (
    !(
      (url.hostname === "nextjs.org" || url.hostname === "vercel.com") &&
      (url.pathname === "/docs" || url.pathname.startsWith("/docs/"))
    )
  )
    return;

  if (url.pathname.endsWith(".md")) return;
  url.pathname = `${url.pathname.replace(/\/$/, "")}.md`;
  url.hash = "";

  return url;
}

function isLowQualityDocument(document: CompleteDocument): boolean {
  // An authored fallback is readable content, so a site index would be a downgrade.
  if (document.noscriptFallback && !document.extractionDiagnostics?.botWall) return false;

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
): Promise<{ url: string; document: CompleteDocument; aliases?: string[] } | undefined> {
  // Candidates are ordered shallow → deep. Probe from the page upward in small batches:
  // this preserves a preference for the deepest usable index without issuing every
  // ancestor request when a nearby section index already exists.
  const batchSize = 4;

  for (let end = candidates.length; end > 0; end -= batchSize) {
    const start = Math.max(0, end - batchSize);
    const batch = candidates.slice(start, end);

    const documents = await Promise.all(
      batch.map((candidate) => probeUsableRawText(candidate, signal, dependencies)),
    );

    for (let index = documents.length - 1; index >= 0; index -= 1) {
      const document = documents[index];

      if (document) {
        const aliases = documents.flatMap((other, i) =>
          i !== index && other && other.markdown === document.markdown ? [batch[i].href] : [],
        );

        return { url: batch[index].href, document, aliases };
      }
    }
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
          { ...dependencies, solveAnubisChallenges: false, solveAwsWafChallenges: false },
          // An index probe never accepts an empty body.
          false,
          // A probe wants exactly this representation; retrying as HTML only burns
          // a request on a URL that is already known to be missing.
          false,
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
 * - Serves the index instead of the page when the page looks like an app shell, carries
 *   too little readable text, or was withheld by a bot-protection challenge.
 * - Otherwise annotates the page with the index URL so agents can discover sibling pages.
 *
 * A missing or useless index can never degrade the primary fetch.
 */
export async function fetchDocumentWithLlmsTxtSupport(
  rawUrl: string,
  signal: AbortSignal | undefined,
  dependencies: FetchRemoteDependencies,
  preferHtml = false,
): Promise<CompleteDocument> {
  try {
    const url = new URL(rawUrl);
    const match = /^\/jobs\/copr\/(\d+)\/?$/.exec(url.pathname);

    if (
      url.protocol === "https:" &&
      url.host === "dashboard.packit.dev" &&
      !url.username &&
      !url.password &&
      !url.search &&
      match
    ) {
      const apiUrl = `https://prod.packit.dev/api/copr-builds/${match[1]}`;

      try {
        const document = await fetchCompleteDocument(
          apiUrl,
          signal,
          restrictOrigin(dependencies, "https://prod.packit.dev"),
        );

        if (
          new URL(document.url).origin === "https://prod.packit.dev" &&
          document.contentType === "application/json"
        )
          return { ...document, representationFallback: "packit-api" };
      } catch (error) {
        if (signal?.aborted) throw error;
      }
    }

    if (isGitHubLikeHost(url.hostname)) {
      return fetchCompleteDocument(rawUrl, signal, dependencies);
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    // Invalid URL falls through to fetchCompleteDocument which will throw.
  }

  const candidates = buildLlmsTxtCandidateUrls(rawUrl);

  // A withheld page must not discard an index that is still usable, so the pair is
  // settled instead of rejected together.
  const [primarySettled, indexSettled] = await Promise.allSettled([
    fetchCompleteDocument(rawUrl, signal, dependencies, true, true, preferHtml),
    candidates.length > 0
      ? ensureLlmsTxtIndex(candidates, signal, dependencies)
      : Promise.resolve(undefined),
  ]);

  // An index probe only rejects when the caller cancels, which must still surface.
  if (indexSettled.status === "rejected") throw indexSettled.reason;

  if (primarySettled.status === "rejected") {
    // A bot-protection layer replaced the page with a challenge that carries no
    // content; the discovered index is the only remaining pointer to that content.
    if (indexSettled.value && primarySettled.reason instanceof ChallengeBlockedError)
      return { ...indexSettled.value.document, llmsTxtFallback: true };

    throw primarySettled.reason;
  }

  const primary = primarySettled.value;

  // A `describedby` advertisement names the covering index authoritatively per
  // llmstxt.org v2, so it outranks the blind root/section probes whenever usable.
  let index = indexSettled.value;

  if (primary.llmsTxtDescribedBy) {
    const describedBy = toAbsoluteUrl(primary.llmsTxtDescribedBy);

    const described =
      describedBy && isSafeToProbe(describedBy, primary.url)
        ? await probeUsableRawText(describedBy, signal, dependencies)
        : undefined;

    if (described && describedBy && index?.url !== describedBy.href)
      index = { url: describedBy.href, document: described };
  }

  if (
    !primary.markdown.trim() &&
    primary.swaggerSpecUrl &&
    isSafeToProbe(toAbsoluteUrl(primary.swaggerSpecUrl), primary.url)
  ) {
    try {
      const spec = await fetchCompleteDocument(
        primary.swaggerSpecUrl,
        signal,
        restrictOrigin(dependencies, new URL(primary.url).origin),
        false,
        false,
      );

      if (isSafeToProbe(toAbsoluteUrl(spec.url), primary.url) && spec.openapiSpec)
        return { ...spec, representationFallback: "swagger-spec" };
    } catch (error) {
      if (signal?.aborted) throw error;
    }
  }

  // Prefer a page-specific Markdown representation even when HTML extraction succeeded.
  // Restrict the entire redirect chain, and never substitute HTML or arbitrary text.
  if (
    !primary.surfaceView &&
    primary.extractor !== "raw" &&
    (!primary.markdownAlternateUrl || (!isLowQualityDocument(primary) && primary.markdown.trim()))
  ) {
    const advertised = primary.markdownAlternateUrl
      ? toAbsoluteUrl(primary.markdownAlternateUrl)
      : undefined;

    const candidate = advertised ?? documentationMarkdownUrl(primary.url);

    if (candidate && isSafeToProbe(candidate, primary.url) && candidate.href !== primary.url) {
      try {
        const alternate = await fetchCompleteDocument(
          candidate.href,
          signal,
          restrictOrigin(dependencies, new URL(primary.url).origin),
          false,
          false,
        );

        if (
          alternate.extractor === "raw" &&
          /^(text\/markdown|text\/x-markdown)(?:;|$)/i.test(alternate.contentType) &&
          alternate.markdown.trim().length >= LLMS_TXT_MIN_MARKDOWN_CHARACTERS &&
          !alternate.shellSuspected
        )
          return {
            ...alternate,
            markdownAlternateFallback: true,
            markdownAlternateReason: advertised ? "advertised" : "preferred",
            llmsTxtIndexUrl: index?.url,
            llmsTxtIndexAliases: index?.aliases,
          };
      } catch (error) {
        if (signal?.aborted) throw error;
      }
    }
  }

  if (isLowQualityDocument(primary) || !primary.markdown.trim()) {
    // The page's own advertised Markdown version is strictly better than an index.
    const markdownAlternate = primary.markdownAlternateUrl
      ? toAbsoluteUrl(primary.markdownAlternateUrl)
      : undefined;

    const alternate =
      !primary.surfaceView && markdownAlternate && isSafeToProbe(markdownAlternate, primary.url)
        ? await probeUsableRawText(markdownAlternate, signal, dependencies)
        : undefined;

    if (alternate && markdownAlternate) {
      return {
        ...alternate,
        markdownAlternateFallback: true,
        markdownAlternateReason: "advertised",
      };
    }

    if (index) return { ...index.document, llmsTxtFallback: true };
  } else if (index) {
    return { ...primary, llmsTxtIndexUrl: index.url, llmsTxtIndexAliases: index.aliases };
  }

  if (
    !primary.markdown.trim() &&
    (!primary.links || (primary.links.internal.length === 0 && primary.links.external.length === 0))
  ) {
    // Preserve diagnostics for empty challenge pages and JavaScript app shells.
    if (primary.extractionDiagnostics?.botWall || primary.extractionDiagnostics?.javascriptRequired)
      return primary;

    throw new Error("web_fetch: Page has no extractable content.");
  }

  return primary;
}
