import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { fetchAgyModels, parseAgyModels } from "../src/agy-models";

describe("agy model fallback", () => {
  it("parses runtime variants and ignores progress and malformed lines", () => {
    const models = parseAgyModels(
      [
        "Fetching available models...",
        "example-low\tExample (Low)",
        "example-high\tExample (High)",
        "example-low\tDuplicate",
        "bad id\tBad",
        "evil-low\t\u001b[31mUnsafe",
      ].join("\n"),
    );

    expect(models).toHaveLength(1);
    expect(models?.[0]).toMatchObject({
      id: "example",
      input: ["text"],
      thinkingLevelMap: { low: "example-low", high: "example-high" },
    });
    expect(parseAgyModels("not a catalog")).toBeUndefined();
  });

  it("runs the installed CLI and falls back when it fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agy-models-"));
    const previous = process.env.PATH;
    process.env.PATH = directory;

    try {
      writeFileSync(
        join(directory, "agy"),
        "#!/bin/sh\nprintf 'example-low\\tExample (Low)\\n'\n",
        { mode: 0o755 },
      );
      expect((await fetchAgyModels(new AbortController().signal))?.[0].id).toBe("example");
      writeFileSync(join(directory, "agy"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      expect(await fetchAgyModels(new AbortController().signal)).toBeUndefined();
    } finally {
      process.env.PATH = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("honors cancellation", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(fetchAgyModels(controller.signal)).rejects.toThrow("cancelled");
  });
});
