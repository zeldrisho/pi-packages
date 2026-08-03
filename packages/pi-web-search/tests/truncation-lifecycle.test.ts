import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { createSearchHarness, jsonResponse } from "./harness";

describe("web_search truncation lifecycle", () => {
  it("writes truncated context output to a temporary file", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "large-context-secret";
    const generic = Array.from({ length: 20 }, (_, index) => ({
      title: `Result ${index}`,
      url: `https://example.com/${index}`,
      snippets: ["a".repeat(8_000), "b".repeat(8_000), "c".repeat(8_000)],
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ grounding: { generic } })),
    );

    const harness = createSearchHarness();
    const result = await harness.tool.execute(
      "call",
      { query: "large context output", mode: "context", count: 20 },
      undefined,
      undefined,
    );
    expect(result.details.truncated).toBe(true);
    expect(result.details.fullOutputPath).toBeDefined();
    const fullOutputPath = result.details.fullOutputPath!;
    const tempDirectory = dirname(fullOutputPath);
    try {
      const fullOutput = await readFile(fullOutputPath, "utf8");
      expect(fullOutput.length).toBeGreaterThan(50_000);
      expect(result.details.truncation).toEqual({
        truncated: true,
        strategy: "temporary-file",
        fullOutputPath,
        outputBytes: expect.any(Number),
        totalBytes: new TextEncoder().encode(fullOutput).byteLength,
        outputLines: expect.any(Number),
        totalLines: fullOutput.split("\n").length,
      });
      expect(result.details.truncation.outputBytes).toBeLessThan(
        result.details.truncation.totalBytes,
      );
      expect(result.details.truncation.outputLines).toBeLessThanOrEqual(
        result.details.truncation.totalLines,
      );
      const shutdown = harness.getShutdownHandler();
      expect(shutdown).toBeDefined();
      await shutdown!();
      await expect(readFile(fullOutputPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(shutdown!()).resolves.toBeUndefined();
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
