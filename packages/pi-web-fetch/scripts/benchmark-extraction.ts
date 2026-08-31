#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Type, type Static } from "typebox";
import { Parse } from "typebox/value";
import { fetchCompleteDocument } from "../src/fetch";

const CorpusEntrySchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  category: Type.String({ minLength: 1 }),
  url: Type.String({ minLength: 1 }),
  requiredMarkers: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  minimumCharacters: Type.Integer({ minimum: 1 }),
});
const CorpusSchema = Type.Array(CorpusEntrySchema, { minItems: 1 });
type CorpusEntry = Static<typeof CorpusEntrySchema>;

interface BenchmarkResult {
  name: string;
  category: string;
  url: string;
  passed: boolean;
  extractor?: string;
  characterCount: number;
  latencyMs: number;
  missingMarkers: string[];
  error?: string;
}

interface BenchmarkOptions {
  corpusPath: string;
  filter?: string;
  json: boolean;
  timeoutMs: number;
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultCorpusPath = resolve(scriptDirectory, "extraction-corpus.json");

function usage(): string {
  return [
    "Usage: vp exec jiti scripts/benchmark-extraction.ts [options]",
    "",
    "Options:",
    "  --corpus <path>   Corpus JSON path",
    "  --filter <value>  Run entries whose category or name contains value",
    "  --timeout <ms>    Per-URL timeout (default: 20000)",
    "  --json            Emit machine-readable JSON",
  ].join("\n");
}

function parsePositiveInteger(value: string | undefined, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} requires a positive integer.`);
  }
  return parsed;
}

export function parseBenchmarkOptions(arguments_: string[]): BenchmarkOptions {
  const options: BenchmarkOptions = {
    corpusPath: defaultCorpusPath,
    json: false,
    timeoutMs: 20_000,
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--corpus") {
      const value = arguments_[index + 1];
      if (!value) throw new Error("--corpus requires a path.");
      options.corpusPath = resolve(value);
      index += 1;
    } else if (argument === "--filter") {
      const value = arguments_[index + 1];
      if (!value) throw new Error("--filter requires a value.");
      options.filter = value.toLowerCase();
      index += 1;
    } else if (argument === "--timeout") {
      options.timeoutMs = parsePositiveInteger(arguments_[index + 1], "--timeout");
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    } else throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

export function parseCorpusJson(serialized: string): CorpusEntry[] {
  const corpus = Parse(CorpusSchema, JSON.parse(serialized));
  for (const [index, entry] of corpus.entries()) {
    try {
      const url = new URL(entry.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsafe protocol");
    } catch {
      throw new Error(`Extraction corpus entry at index ${index} needs an HTTP(S) URL.`);
    }
  }
  return corpus;
}

async function benchmarkEntry(entry: CorpusEntry, timeoutMs: number): Promise<BenchmarkResult> {
  const startedAt = performance.now();
  try {
    const document = await fetchCompleteDocument(entry.url, undefined, { timeoutMs });
    const normalizedMarkdown = document.markdown.toLocaleLowerCase();
    const missingMarkers = entry.requiredMarkers.filter(
      (marker) => !normalizedMarkdown.includes(marker.toLocaleLowerCase()),
    );
    const characterCount = document.markdown.length;
    return {
      name: entry.name,
      category: entry.category,
      url: entry.url,
      passed: characterCount >= entry.minimumCharacters && missingMarkers.length === 0,
      extractor: document.extractor,
      characterCount,
      latencyMs: Math.round(performance.now() - startedAt),
      missingMarkers,
    };
  } catch (cause) {
    return {
      name: entry.name,
      category: entry.category,
      url: entry.url,
      passed: false,
      characterCount: 0,
      latencyMs: Math.round(performance.now() - startedAt),
      missingMarkers: entry.requiredMarkers,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

export async function runBenchmark(options: BenchmarkOptions): Promise<BenchmarkResult[]> {
  const corpus = parseCorpusJson(await readFile(options.corpusPath, "utf8")).filter((entry) => {
    if (!options.filter) return true;
    return `${entry.category}\n${entry.name}`.toLowerCase().includes(options.filter);
  });
  if (corpus.length === 0) throw new Error("No extraction corpus entries matched the filter.");

  const results: BenchmarkResult[] = [];
  for (const entry of corpus) results.push(await benchmarkEntry(entry, options.timeoutMs));
  return results;
}

function printResults(results: BenchmarkResult[], json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(results, undefined, 2)}\n`);
    return;
  }
  for (const result of results) {
    const status = result.passed ? "PASS" : "FAIL";
    const extractor = result.extractor ? `, ${result.extractor}` : "";
    process.stdout.write(
      `${status} ${result.name}: ${result.characterCount} chars, ${result.latencyMs}ms${extractor}\n`,
    );
    if (result.missingMarkers.length > 0) {
      process.stdout.write(`  missing markers: ${result.missingMarkers.join(", ")}\n`);
    }
    if (result.error) process.stdout.write(`  error: ${result.error}\n`);
  }
  const passed = results.filter((result) => result.passed).length;
  process.stdout.write(`\n${passed}/${results.length} extraction checks passed.\n`);
}

async function main(): Promise<void> {
  try {
    const options = parseBenchmarkOptions(process.argv.slice(2));
    const results = await runBenchmark(options);
    printResults(results, options.json);
    if (results.some((result) => !result.passed)) process.exitCode = 1;
  } catch (cause) {
    process.stderr.write(
      `${cause instanceof Error ? cause.message : String(cause)}\n\n${usage()}\n`,
    );
    process.exitCode = 1;
  }
}

const entryPath = process.argv[1];
if (entryPath && pathToFileURL(resolve(entryPath)).href === import.meta.url) await main();
