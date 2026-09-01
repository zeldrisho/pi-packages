#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { focusMarkdown } from "../src/focus";

interface FocusCase {
  name: string;
  dimension: "heading" | "phrase" | "stemming";
  query: string;
  markdown: string;
  expectedMarker: string;
}

const corpusPath = resolve(dirname(fileURLToPath(import.meta.url)), "focus-corpus.json");
// SAFETY: This repository-owned benchmark fixture is reviewed together with this script.
const corpus = JSON.parse(await readFile(corpusPath, "utf8")) as FocusCase[];
const results = corpus.map((entry) => {
  const result = focusMarkdown(entry.markdown, entry.query);
  return {
    name: entry.name,
    dimension: entry.dimension,
    matched: result.markdown.includes(entry.expectedMarker),
    selectedSections: result.details.matchedSections,
    totalSections: result.details.totalSections,
  };
});
const summary = Object.fromEntries(
  (["heading", "phrase", "stemming"] as const).map((dimension) => {
    const cases = results.filter((result) => result.dimension === dimension);
    return [
      dimension,
      { matched: cases.filter((result) => result.matched).length, total: cases.length },
    ];
  }),
);
process.stdout.write(`${JSON.stringify({ summary, results }, undefined, 2)}\n`);
