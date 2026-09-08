import type { Action } from "./config";

export interface RuleMatch {
  pattern: string;
  action: Action;
}

/**
 * Resolves the rule that applies to a command against the configured rules.
 *
 * Returns `null` when no rule matches, in which case the caller should let the
 * command through. When multiple rules match, the longest pattern wins so
 * that narrow rules can override broader ones.
 *
 * @param command - The bash command to evaluate against the rules
 * @param rules - A map of pattern strings to actions
 * @returns The matched pattern and action, or `null` if no rule matches
 */
export function resolveRule(command: string, rules: Record<string, Action>): RuleMatch | null {
  let bestPattern: string | null = null;
  for (const pattern of Object.keys(rules)) {
    if (!command.includes(pattern)) continue;
    if (bestPattern === null || pattern.length > bestPattern.length) {
      bestPattern = pattern;
    }
  }
  if (bestPattern === null) return null;
  return { pattern: bestPattern, action: rules[bestPattern] };
}

/** Returns only the action selected by {@link resolveRule}. */
export function resolveAction(command: string, rules: Record<string, Action>): Action | null {
  return resolveRule(command, rules)?.action ?? null;
}
