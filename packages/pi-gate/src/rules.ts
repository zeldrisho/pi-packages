import type { Action } from "./config";

export interface RuleMatch {
  pattern: string;
  action: Action;
}

interface RuleOccurrence extends RuleMatch {
  start: number;
  end: number;
  normalizedLength: number;
}

/** Normalize matching text while leaving the original command untouched for display/execution. */
export function normalizeMatchText(text: string): string {
  return text.toLowerCase().replace(/\s+/gu, " ");
}

function findOccurrences(text: string, pattern: string, rule: RuleMatch): RuleOccurrence[] {
  const occurrences: RuleOccurrence[] = [];
  let offset = 0;

  while (offset <= text.length - pattern.length) {
    const start = text.indexOf(pattern, offset);

    if (start === -1) break;
    occurrences.push({
      ...rule,
      start,
      end: start + pattern.length,
      normalizedLength: pattern.length,
    });
    // Advance one code unit so overlapping occurrences are retained.
    offset = start + 1;
  }

  return occurrences;
}

/**
 * Resolves all matching spans. An allow only suppresses a prompt/block occurrence
 * when that allow occurrence fully contains it. A surviving block takes priority
 * over prompt; the longest pattern for the winning action is reported.
 */
export function resolveRule(command: string, rules: Record<string, Action>): RuleMatch | null {
  const normalizedCommand = normalizeMatchText(command);
  const occurrences: RuleOccurrence[] = [];

  let acceptedRuleCount = 0;

  for (const [pattern, action] of Object.entries(rules)) {
    if (acceptedRuleCount >= 1_000) break;

    if (pattern.length === 0 || pattern.length > 1_024) continue;
    const normalizedPattern = normalizeMatchText(pattern);

    if (!normalizedPattern) continue;
    occurrences.push(...findOccurrences(normalizedCommand, normalizedPattern, { pattern, action }));
    acceptedRuleCount += 1;
  }

  const allows = occurrences.filter((occurrence) => occurrence.action === "allow");

  const surviving = occurrences.filter(
    (occurrence) =>
      occurrence.action === "allow" ||
      !allows.some((allow) => allow.start <= occurrence.start && allow.end >= occurrence.end),
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
