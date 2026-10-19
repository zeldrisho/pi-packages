import { parseHTML } from "linkedom";
import { hasAnubisMarkers } from "../challenges/anubis.ts";

const MAX_LINKS = 16;

const MAX_ANCHOR_CHARACTERS = 120;

/** Bounded, machine-readable reasons that an HTML extraction may be incomplete. */
export interface ExtractionDiagnostics {
  javascriptRequired: boolean;
  botWall: boolean;
  consentInterstitial: boolean;
  sparseExtraction: boolean;
  rawCharacters: number;
  extractedCharacters: number;
}

/** One normalized link found in the fetched document. */
export interface ExtractedLink {
  url: string;
  anchorText: string;
}

/** Bounded links from the fetched document. Linked pages are never fetched implicitly. */
export interface ExtractedLinks {
  internal: ExtractedLink[];
  external: ExtractedLink[];
  omittedInternal: number;
  omittedExternal: number;
}

const JAVASCRIPT_MARKERS = [/enable\s+javascript/i, /javascript\s+(?:is\s+)?required/i];

const BOT_MARKERS = [
  /are\s+you\s+a\s+robot/i,
  /verify\s+you\s+are\s+human/i,
  /checking\s+your\s+browser/i,
  /<title>\s*just\s+a\s+moment/i,
];

// CAPTCHA interstitials (Cap, reCAPTCHA, hCaptcha, Turnstile) are JavaScript-only
// challenge shells that carry no readable text. The loader/class names below appear
// only on challenge shells; generic widget markers additionally require an empty
// extraction so a content-rich page that merely embeds a CAPTCHA is not misreported.
const CAPTCHA_LOADER_MARKERS = [
  /\bcap-loader\.js\b/i,
  /\bcap-captcha\b/i,
  /\bid=["']captcha-form["']/i,
];

const CAPTCHA_WIDGET_MARKERS = [
  /\bid=["']captcha["']/i,
  /\bclass=["'][^"']*\bg-recaptcha\b/i,
  /\bclass=["'][^"']*\bh-captcha\b/i,
  /\bclass=["'][^"']*\bcf-turnstile\b/i,
];

const CAPTCHA_CHALLENGE_MAX_MARKDOWN_CHARACTERS = 200;

const ANUBIS_MARKER = /\banubis\b/i;

const PROOF_OF_WORK_MARKER = /proof[\s-]+of[\s-]+work/i;

const ANUBIS_PROTECTION_MARKERS = [
  /\banubis\s+is\s+protecting\s+this\s+site\b/i,
  /\badministrator\b.{0,160}\bset\s+up\s+anubis\b.{0,160}\bprotect\s+the\s+server\b/i,
];

const CONSENT_MARKERS = [
  /manage\s+(?:your\s+)?consent/i,
  /your\s+(?:privacy\s+)?consent/i,
  /consent\s+to\s+(?:our\s+use\s+of\s+cookies|cookies)/i,
  /accept\s+(?:all\s+)?cookies/i,
  /we\s+use\s+cookies/i,
];

/** Produces explicit, bounded extraction-quality signals instead of one opaque shell flag. */
export function diagnoseExtraction(raw: string, markdown: string): ExtractionDiagnostics {
  const { document } = parseHTML(raw);
  const anubisText = [...document.childNodes].map((node) => node.textContent ?? "").join(" ");

  const captchaChallenge =
    CAPTCHA_LOADER_MARKERS.some((marker) => marker.test(raw)) ||
    (markdown.trim().length < CAPTCHA_CHALLENGE_MAX_MARKDOWN_CHARACTERS &&
      CAPTCHA_WIDGET_MARKERS.some((marker) => marker.test(raw)));

  return {
    javascriptRequired: JAVASCRIPT_MARKERS.some((marker) => marker.test(raw)),
    botWall:
      hasAnubisMarkers(raw) ||
      BOT_MARKERS.some((marker) => marker.test(raw)) ||
      captchaChallenge ||
      (ANUBIS_MARKER.test(anubisText) &&
        ANUBIS_PROTECTION_MARKERS.some((marker) => marker.test(anubisText)) &&
        PROOF_OF_WORK_MARKER.test(anubisText)),
    consentInterstitial: CONSENT_MARKERS.some((marker) => marker.test(raw)),
    sparseExtraction:
      raw.length > 4_000 && markdown.length < 1_024 && markdown.length < raw.length * 0.008,
    rawCharacters: raw.length,
    extractedCharacters: markdown.length,
  };
}

/**
 * Checks if extraction diagnostics indicate any warning conditions.
 *
 * @param diagnostics - Extraction diagnostics to check
 * @returns True if any warning condition is present, false otherwise
 */
export function hasExtractionWarning(diagnostics: ExtractionDiagnostics): boolean {
  return (
    diagnostics.javascriptRequired ||
    diagnostics.botWall ||
    diagnostics.consentInterstitial ||
    diagnostics.sparseExtraction
  );
}

/**
 * Normalizes and truncates anchor text for link extraction.
 *
 * @param value - Raw anchor text
 * @returns Normalized text, truncated to MAX_ANCHOR_CHARACTERS if needed
 */
function normalizedAnchor(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();

  return text.length > MAX_ANCHOR_CHARACTERS
    ? `${text.slice(0, MAX_ANCHOR_CHARACTERS - 1)}…`
    : text;
}

/** Extracts a bounded set of safe HTTP(S) links without making any network requests. */
export function extractDocumentLinks(raw: string, pageUrl: URL): ExtractedLinks {
  const { document } = parseHTML(raw);
  const internal: ExtractedLink[] = [];
  const external: ExtractedLink[] = [];
  let omittedInternal = 0;
  let omittedExternal = 0;
  const seen = new Set<string>();

  for (const element of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const href = element.getAttribute("href");

    if (!href) continue;
    let target: URL;

    try {
      target = new URL(href, pageUrl);
    } catch {
      continue;
    }

    if (!["http:", "https:"].includes(target.protocol) || target.username || target.password)
      continue;
    target.hash = "";
    const anchorText = normalizedAnchor(element.textContent ?? "");
    const key = `${target.href}\0${anchorText}`;

    if (seen.has(key)) continue;
    seen.add(key);
    const isInternal = target.origin === pageUrl.origin;
    const bucket = isInternal ? internal : external;

    if (bucket.length < MAX_LINKS) bucket.push({ url: target.href, anchorText });
    else if (isInternal) omittedInternal += 1;
    else omittedExternal += 1;
  }

  return { internal, external, omittedInternal, omittedExternal };
}
