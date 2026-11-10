import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

import { PI_SUMMARY_TEXT } from "../src/compaction";

/** Files in the installed Pi package that own the summarization text this package mirrors. */
const PI_COMPACTION_SOURCES = [
  "core/compaction/compaction.js",
  "core/compaction/branch-summarization.js",
  "core/compaction/utils.js",
];

/** Reads Pi's compaction sources, so a rewording upgrade fails here instead of drifting silently. */
function readPiCompactionSources(): string {
  const dist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));

  return PI_COMPACTION_SOURCES.map((file) => readFileSync(join(dist, file), "utf8")).join("\n");
}

describe("Pi summarization text", () => {
  it("matches the installed Pi package", () => {
    const source = readPiCompactionSources();

    for (const [name, text] of Object.entries(PI_SUMMARY_TEXT)) {
      expect(source.includes(text), `${name} no longer appears in Pi's compaction sources`).toBe(
        true,
      );
    }
  });
});
