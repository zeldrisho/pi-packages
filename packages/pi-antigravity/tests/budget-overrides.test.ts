import { describe, expect, it } from "vite-plus/test";
import { isBudgetRoute, overrideThinkingBudget } from "../src/budget-overrides";

const advertised = { includeThoughts: true, thinkingBudget: 1024 } as const;

const input = {
  enabled: true,
  level: "high" as const,
  budgets: { high: 8192 },
  advertised,
  maxOutputTokens: 20_000,
};

describe("discovered budget overrides", () => {
  it("recognizes only single-route budget level maps", () => {
    expect(
      isBudgetRoute(
        { minimal: "route", low: "route", medium: "route", high: "route", xhigh: null, max: null },
        "route",
      ),
    ).toBe(true);
    expect(
      isBudgetRoute(
        { minimal: "route", low: "other", medium: "route", high: "route", xhigh: null, max: null },
        "route",
      ),
    ).toBe(false);
    expect(isBudgetRoute(undefined, "route")).toBe(false);
  });
  it("uses configured values, reserves answer room, and retains advertised budget for unset levels", () => {
    expect(overrideThinkingBudget(input)).toEqual({ includeThoughts: true, thinkingBudget: 8192 });
    expect(overrideThinkingBudget({ ...input, enabled: false })).toEqual(advertised);
    expect(overrideThinkingBudget({ ...input, maxOutputTokens: 3000 })).toEqual({
      includeThoughts: true,
      thinkingBudget: 1976,
    });
    expect(overrideThinkingBudget({ ...input, budgets: {} })).toEqual(advertised);
  });
  it("refuses invalid budgets, missing metadata, level-based routes, and insufficient output room", () => {
    expect(() => overrideThinkingBudget({ ...input, budgets: { high: 0 } })).toThrow(
      /positive integer/,
    );
    expect(() => overrideThinkingBudget({ ...input, advertised: undefined })).toThrow(
      /did not advertise/,
    );
    expect(() =>
      overrideThinkingBudget({
        ...input,
        advertised: { includeThoughts: true, thinkingLevel: "HIGH" },
      }),
    ).toThrow(/did not advertise/);
    expect(() => overrideThinkingBudget({ ...input, maxOutputTokens: 1024 })).toThrow(/too small/);
  });
});
