import { describe, expect, it } from "vite-plus/test";
import { normalizeText } from "../../src/provider";

function* values(seed: number): Generator<number> {
  let state = seed >>> 0;

  while (true) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    yield state;
  }
}

describe("provider text normalization properties", () => {
  it("keeps generated untrusted payload strings bounded and whitespace-normalized", () => {
    const random = values(0xb4a7e);
    const alphabet = ["word", "<script>alert(1)</script>", "\n\t", "é", "🙂"];

    for (let sample = 0; sample < 128; sample += 1) {
      const input = Array.from(
        { length: 200 },
        () => alphabet[random.next().value! % alphabet.length],
      ).join(" ");

      const output = normalizeText(input, 80);

      expect(output.length).toBeLessThanOrEqual(80);
      expect(output).toBe(output.trim());
      expect(output).not.toMatch(/\s{2,}/u);
      expect(output).not.toContain("<script>");
    }
  });

  it("handles zero and tiny output budgets without exceeding the requested bound", () => {
    for (const limit of [0, 1, 2, 8]) {
      expect(normalizeText("<b>hostile</b>  payload", limit).length).toBeLessThanOrEqual(limit);
    }
  });
});
