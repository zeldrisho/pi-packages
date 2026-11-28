import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { parseSyncArguments, sync } from "../scripts/sync-web-modules.ts";

describe("parseSyncArguments", () => {
  it("defaults to check and accepts both --from spellings for sync", () => {
    expect.soft(parseSyncArguments([]), "no arguments").toEqual({
      command: "check",
      from: "pi-web-fetch",
    });

    for (const args of [["--from=pi-web-search"], ["--from", "pi-web-search"]]) {
      expect.soft(parseSyncArguments(["sync", ...args]), args.join(" ")).toEqual({
        command: "sync",
        from: "pi-web-search",
      });
    }
  });

  it("rejects invalid commands and options", () => {
    const samples = [
      [["sync", "--from", "nope"], "--from must be one of"],
      [["sync", "--from=pi-web-fetch", "--from=pi-web-search"]],
      [["sync", "--from=pi-web-fetch=extra"]],
      [["sync", "--unknown"]],
      [["check", "--from=pi-web-fetch"]],
      [["frobnicate"], "unknown command"],
    ] satisfies [string[], string?][];

    for (const [args, message] of samples) {
      expect.soft(() => parseSyncArguments(args), args.join(" ")).toThrow(message);
    }
  });
});

describe("sync", () => {
  it("does not copy any files if a source is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "sync-web-modules-"));

    try {
      const source = join(root, "packages", "pi-web-fetch", "src");
      const target = join(root, "packages", "pi-web-search", "src");
      mkdirSync(source, { recursive: true });
      mkdirSync(target, { recursive: true });
      writeFileSync(join(source, "cache.ts"), "new");
      writeFileSync(join(target, "cache.ts"), "old");
      expect(sync("pi-web-fetch", root)).toBe(1);
      expect(readFileSync(join(target, "cache.ts"), "utf8")).toBe("old");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
