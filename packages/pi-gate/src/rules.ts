import type { Action } from "./config";
import { literalCommands } from "./literal-commands";

export interface RuleMatch {
  pattern: string;
  action: Action;
}

interface RuleOccurrence extends RuleMatch {
  start: number;
  end: number;
  normalizedLength: number;
  scope: number;
}

interface RuleText {
  text: string;
  scope: number;
  wholeWords: boolean;
  literalOutput: boolean;
}

/** Normalize matching text while leaving the original command untouched for display/execution. */
export function normalizeMatchText(text: string): string {
  return text.toLowerCase().replace(/\s+/gu, " ");
}

function findOccurrences(context: RuleText, pattern: string, rule: RuleMatch): RuleOccurrence[] {
  const occurrences: RuleOccurrence[] = [];
  const { text } = context;
  let offset = 0;

  while (offset <= text.length - pattern.length) {
    const start = text.indexOf(pattern, offset);

    if (start === -1) break;
    const end = start + pattern.length;
    const lastWord = pattern.slice(pattern.lastIndexOf(" ") + 1);

    // Do not silently stop gating combined flags (-rfv) or extended modes
    // (7777). Allow exceptions still require the complete final word.
    const restrictivePrefix =
      rule.action !== "allow" && (lastWord.startsWith("-") || /^\d+$/u.test(lastWord));

    const bounded =
      !context.wholeWords ||
      ((start === 0 || text[start - 1] === " " || text[start - 1] === "/") &&
        (end === text.length || text[end] === " " || restrictivePrefix));

    if (bounded && (!context.literalOutput || start === 0)) {
      occurrences.push({
        ...rule,
        start,
        end,
        scope: context.scope,
        normalizedLength: pattern.length,
      });
    }

    // Advance one code unit so overlapping occurrences are retained.
    offset = start + 1;
  }

  return occurrences;
}

/**
 * Matches whole words in recognized literal commands, excluding data arguments
 * to echo/printf. Complex syntax or patterns retain conservative text matching.
 * Allows suppress only contained restrictions in the same command; surviving
 * blocks take priority, with the longest pattern reported for the winning action.
 */
export function resolveRule(command: string, rules: Record<string, Action>): RuleMatch | null {
  const acceptedRules: RuleMatch[] = [];

  for (const [pattern, action] of Object.entries(rules)) {
    if (acceptedRules.length >= 1_000) break;

    if (pattern.length === 0 || pattern.length > 1_024) continue;
    acceptedRules.push({ pattern, action });
  }

  // Shell syntax in a rule keeps its existing textual meaning.
  const simplePatterns = acceptedRules.every(({ pattern }) =>
    /^[\p{L}\p{N}_./:@%+=,-]+(?: [\p{L}\p{N}_./:@%+=,-]+)*$/u.test(normalizeMatchText(pattern)),
  );

  const literal = simplePatterns ? literalCommands(command) : undefined;

  const contexts: RuleText[] = literal
    ? literal.map((entry, scope) => ({
        ...entry,
        text: normalizeMatchText(entry.text),
        scope,
        wholeWords: true,
      }))
    : [{ text: normalizeMatchText(command), scope: 0, wholeWords: false, literalOutput: false }];

  const occurrences: RuleOccurrence[] = [];

  for (const rule of acceptedRules) {
    const pattern = normalizeMatchText(rule.pattern);

    for (const context of contexts) occurrences.push(...findOccurrences(context, pattern, rule));
  }

  const allows = occurrences.filter((occurrence) => occurrence.action === "allow");

  const surviving = occurrences.filter(
    (occurrence) =>
      occurrence.action === "allow" ||
      !allows.some(
        (allow) =>
          allow.scope === occurrence.scope &&
          allow.start <= occurrence.start &&
          allow.end >= occurrence.end,
      ),
  );

  const action: Action | null = surviving.some((occurrence) => occurrence.action === "block")
    ? "block"
    : surviving.some((occurrence) => occurrence.action === "prompt")
      ? "prompt"
      : surviving.some((occurrence) => occurrence.action === "allow")
        ? "allow"
        : null;

  if (action === null) return null;

  const winner = surviving
    .filter((occurrence) => occurrence.action === action)
    .sort((a, b) => b.normalizedLength - a.normalizedLength)[0];

  return winner ? { pattern: winner.pattern, action: winner.action } : null;
}

/** Returns the selected action, or null when no rule matches. */
export function resolveAction(command: string, rules: Record<string, Action>): Action | null {
  return resolveRule(command, rules)?.action ?? null;
}
