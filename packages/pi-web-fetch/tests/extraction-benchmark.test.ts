import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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
  it("runs directly under Node's TypeScript stripping", () => {
    const script = fileURLToPath(new URL("../scripts/benchmark-extraction.ts", import.meta.url));
    expect(execFileSync(process.execPath, [script, "--help"], { encoding: "utf8" })).toContain(
      "Usage:",
    );
  });

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
