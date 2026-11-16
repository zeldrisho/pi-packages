import type { ModelThinkingLevel, ThinkingBudgets, ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { ThinkingConfig } from "./models.ts";

/** Recognize the single-route budget controls produced by catalog discovery. */
export function isBudgetRoute(map: ThinkingLevelMap | undefined, runtimeId: string): boolean {
  return (
    map?.minimal === runtimeId &&
    map.low === runtimeId &&
    map.medium === runtimeId &&
    map.high === runtimeId &&
    map.xhigh === null &&
    map.max === null
  );
}

/** Apply only configured Pi budgets to a route still advertising token budgets. */
export function overrideThinkingBudget(input: {
  enabled: boolean;
  level: ModelThinkingLevel | undefined;
  budgets: ThinkingBudgets | undefined;
  advertised: ThinkingConfig | undefined;
  maxOutputTokens: number;
}): ThinkingConfig | undefined {
  if (!input.enabled || input.level === undefined || input.level === "off") return input.advertised;

  if (
    !(
      input.level === "minimal" ||
      input.level === "low" ||
      input.level === "medium" ||
      input.level === "high"
    )
  )
    return input.advertised;
  const budget = input.budgets?.[input.level];

  if (budget === undefined) return input.advertised;

  if (!Number.isSafeInteger(budget) || budget < 1)
    throw new Error("Antigravity thinking budget must be a positive integer.");

  if (
    input.advertised === undefined ||
    !("thinkingBudget" in input.advertised) ||
    input.advertised.thinkingBudget <= 0
  ) {
    throw new Error(
      "Antigravity cannot override thinking: the runtime did not advertise a token budget.",
    );
  }

  const maximum = input.maxOutputTokens - 1024;

  if (maximum < 1)
    throw new Error("Antigravity output limit is too small for a thinking budget and answer.");

  return { includeThoughts: true, thinkingBudget: Math.min(budget, maximum) };
}
