import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { Check } from "typebox/value";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { webSearchOutputSchema } from "../src/search";
import { answerResponse, createSearchHarness } from "./harness";

describe("web_search truncation lifecycle", () => {
  it("bounds JSON escaping even when the model-facing text fits", async () => {
    process.env.BRAVE_ANSWERS_API_KEY = "escaped-answer-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answerResponse(['"'.repeat(28_000)])),
    );
    const harness = createSearchHarness();

    try {
      const result = await harness.tool.execute(
        "call",
        { query: "escaped structured answer", mode: "answers" },
        undefined,
        undefined,
      );

      expect(Check(webSearchOutputSchema, result.structuredContent)).toBe(true);
      expect(result.structuredContent).toMatchObject({ payloadOmitted: true, truncated: true });
      expect(result.content[0].text).toContain("Structured payload omitted");
      expect(Buffer.byteLength(JSON.stringify(result.structuredContent))).toBeLessThanOrEqual(
        DEFAULT_MAX_BYTES,
      );
      expect(result.details.fullOutputPath).toBeDefined();
      expect(await readFile(result.details.fullOutputPath!, "utf8")).toContain('"'.repeat(28_000));
    } finally {
      await harness.getShutdownHandler()?.();
    }
  });
  it("writes truncated Answers output to a temporary file", async () => {
    process.env.BRAVE_ANSWERS_API_KEY = "large-answer-secret";

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answerResponse(["a".repeat(60_000)])),
    );

    const harness = createSearchHarness();

    const result = await harness.tool.execute(
      "call",
      { query: "large answer output", mode: "answers" },
      undefined,
      undefined,
    );

    expect(Check(webSearchOutputSchema, result.structuredContent)).toBe(true);
    expect(result.structuredContent).toMatchObject({
      resultType: "generated-answer",
      payloadOmitted: true,
      results: [],
      truncated: true,
      fullOutputPath: result.details.fullOutputPath,
    });
    expect(result.structuredContent).not.toHaveProperty("answer");
    expect(Buffer.byteLength(JSON.stringify(result.structuredContent))).toBeLessThanOrEqual(
      DEFAULT_MAX_BYTES,
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
