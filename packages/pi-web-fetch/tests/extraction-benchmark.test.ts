import { describe, expect, it } from "vite-plus/test";
import { parseBenchmarkOptions, parseCorpusJson } from "../scripts/benchmark-extraction";

const validEntry = {
  name: "fixture",
  category: "html",
  url: "https://example.com/",
  requiredMarkers: ["Example Domain"],
  minimumCharacters: 100,
};

describe("extraction benchmark", () => {
  it("parses filters, timeouts, JSON output, and corpus paths", () => {
    const options = parseBenchmarkOptions([
      "--filter",
      "Documentation",
      "--timeout",
      "1500",
      "--json",
      "--corpus",
      "fixtures/corpus.json",
    ]);

    expect(options.filter).toBe("documentation");
    expect(options.timeoutMs).toBe(1500);
    expect(options.json).toBe(true);
    expect(options.corpusPath).toMatch(/fixtures[/\\]corpus\.json$/);
  });

  it("rejects malformed command-line values", () => {
    expect(() => parseBenchmarkOptions(["--timeout", "0"])).toThrow(
      "--timeout requires a positive integer",
    );
    expect(() => parseBenchmarkOptions(["--unknown"])).toThrow("Unknown option");
  });

  it("accepts a non-empty corpus of public HTTP entries", () => {
    expect(parseCorpusJson(JSON.stringify([validEntry]))).toEqual([validEntry]);
  });

  it("rejects entries without markers or a positive size floor", () => {
    expect(() =>
      parseCorpusJson(JSON.stringify([{ ...validEntry, requiredMarkers: [] }])),
    ).toThrow();
    expect(() =>
      parseCorpusJson(JSON.stringify([{ ...validEntry, minimumCharacters: 0 }])),
    ).toThrow();
  });
});
