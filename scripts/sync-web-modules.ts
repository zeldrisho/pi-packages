#!/usr/bin/env node
// scripts/sync-web-modules.ts
//
// Keep packages/pi-web-fetch/src/{cache,inflight,render}.ts byte-for-byte
// identical to packages/pi-web-search/src/{cache,inflight,render}.ts.
//
//   node scripts/sync-web-modules.ts            # check (default)
//   node scripts/sync-web-modules.ts check
//   node scripts/sync-web-modules.ts sync [--from pi-web-fetch|pi-web-search]
//
// The three files stay duplicated (no shared package) per AGENTS.md; this
// script only automates copying one side to the other so the agent never has
// to remember the manual write. `tests/repository-contract.test.ts` still
// fails the build on drift as the source of truth.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname ?? process.cwd(), "..");
const PACKAGES = ["pi-web-fetch", "pi-web-search"] as const;
const FILES = ["cache.ts", "inflight.ts", "render.ts"] as const;

function pairs() {
  return FILES.map((file) => ({
    file,
    a: join(ROOT, "packages", PACKAGES[0], "src", file),
    b: join(ROOT, "packages", PACKAGES[1], "src", file),
  }));
}

function read(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function check(): number {
  let drift = 0;
  for (const { file, a, b } of pairs()) {
    const left = read(a);
    const right = read(b);
    if (left === null || right === null) {
      console.error(`missing: ${left === null ? a : b}`);
      drift += 1;
      continue;
    }
    if (left !== right) {
      console.error(`DRIFT: ${file} differs between ${PACKAGES[0]} and ${PACKAGES[1]}`);
      drift += 1;
    } else {
      console.log(`ok: ${file}`);
    }
  }
  return drift;
}

function sync(from: string): number {
  if (!PACKAGES.includes(from as (typeof PACKAGES)[number])) {
    console.error(`--from must be one of: ${PACKAGES.join(", ")}`);
    return 1;
  }
  const source = from === PACKAGES[0] ? PACKAGES[0] : PACKAGES[1];
  const target = source === PACKAGES[0] ? PACKAGES[1] : PACKAGES[0];
  for (const { file } of pairs()) {
    const src = join(ROOT, "packages", source, "src", file);
    const dst = join(ROOT, "packages", target, "src", file);
    const content = read(src);
    if (content === null) {
      console.error(`missing source: ${src}`);
      return 1;
    }
    writeFileSync(dst, content, "utf8");
    console.log(`synced ${file}: ${source} -> ${target}`);
  }
  return check() === 0 ? 0 : 1;
}

const [cmd = "check", ...rest] = process.argv.slice(2);
const fromFlag = rest.find((arg) => arg.startsWith("--from="));
const from = fromFlag ? fromFlag.split("=")[1] : PACKAGES[0];

let code = 0;
if (cmd === "check") code = check() === 0 ? 0 : 1;
else if (cmd === "sync") code = sync(from);
else {
  console.error(`unknown command: ${cmd} (expected "check" or "sync")`);
  code = 1;
}
process.exit(code);
