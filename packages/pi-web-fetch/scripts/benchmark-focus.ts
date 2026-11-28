#!/usr/bin/env node
/// <reference types="node" />

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { focusMarkdown } from "../src/document/focus.ts";

interface FocusCase {
  name: string;
  dimension: "heading" | "phrase" | "stemming" | "identifier" | "code" | "table";
  query: string;
  markdown: string;
  expectedMarker: string;
  excludedMarker?: string;
}

const corpusPath = resolve(import.meta.dirname, "focus-corpus.json");

// SAFETY: This repository-owned benchmark fixture is reviewed together with this script.
const corpus = JSON.parse(await readFile(corpusPath, "utf8")) as FocusCase[];

const results = corpus.map((entry) => {
  const result = focusMarkdown(entry.markdown, entry.query);

  return {
    name: entry.name,
    dimension: entry.dimension,
    matched:
      result.markdown.includes(entry.expectedMarker) &&
      (!entry.excludedMarker || !result.markdown.includes(entry.excludedMarker)),
    selectedSections: result.details.matchedSections,
    totalSections: result.details.totalSections,
  };
});

const summary = Object.fromEntries(
  (["heading", "phrase", "stemming", "identifier", "code", "table"] as const).map((dimension) => {
    const cases = results.filter((result) => result.dimension === dimension);

    return [
      dimension,
      { matched: cases.filter((result) => result.matched).length, total: cases.length },
    ];
  }),
);

process.stdout.write(`${JSON.stringify({ summary, results }, undefined, 2)}\n`);
