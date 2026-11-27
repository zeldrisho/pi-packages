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
  it("parses supported benchmark options and rejects invalid arguments", () => {
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

    expect(() => parseBenchmarkOptions(["--timeout", "0"])).toThrow(
      "--timeout requires a positive integer",
    );
    expect(() => parseBenchmarkOptions(["--unknown"])).toThrow("Unknown option");
  });

  it("requires each corpus entry to include markers and a positive size floor", () => {
    expect(parseCorpusJson(JSON.stringify([validEntry]))).toEqual([validEntry]);
    expect(() =>
      parseCorpusJson(JSON.stringify([{ ...validEntry, requiredMarkers: [] }])),
    ).toThrow();
    expect(() =>
      parseCorpusJson(JSON.stringify([{ ...validEntry, minimumCharacters: 0 }])),
    ).toThrow();
  });
});
