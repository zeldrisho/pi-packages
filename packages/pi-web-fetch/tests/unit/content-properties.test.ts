import { describe, expect, it } from "vite-plus/test";
import { sliceCompleteDocument } from "../../src/content";

function* values(seed: number): Generator<number> {
  let state = seed >>> 0;

  while (true) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    yield state;
  }
}

const document = (markdown: string) => ({
  url: "https://example.test/",
  contentType: "text/markdown",
  markdown,
  extractor: "raw" as const,
  shellSuspected: false,
});

describe("document slicing properties", () => {
  it("returns bounded, progressing continuation offsets for generated Unicode documents", () => {
    const random = values(0x51ce);
    const alphabet = ["a", "é", "界", "🙂", "\n"];

    for (let sample = 0; sample < 64; sample += 1) {
      const markdown = Array.from(
        { length: 5_000 },
        () => alphabet[random.next().value! % alphabet.length],
      ).join("");

      const offset = random.next().value! % 2_000;
      const result = sliceCompleteDocument(document(markdown), offset, 1_000);

      expect(result.totalCharacters).toBe(markdown.length);
      expect(result.offset).toBe(offset);
      expect(result.markdown.length).toBeLessThanOrEqual(1_100);

      if (result.truncated) {
        expect(result.nextOffset).toBeDefined();
        expect(result.nextOffset).toBeGreaterThan(offset);
        expect(result.nextOffset).toBeLessThanOrEqual(markdown.length);
        expect(result.markdown.startsWith(markdown.slice(offset, result.nextOffset))).toBe(true);
      } else {
        expect(result.nextOffset).toBeUndefined();
      }
    }
  });
});
