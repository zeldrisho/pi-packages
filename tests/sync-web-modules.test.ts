import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { parseSyncArguments, sync } from "../scripts/sync-web-modules.ts";

describe("parseSyncArguments", () => {
  it("defaults to check with pi-web-fetch", () => {
    expect(parseSyncArguments([])).toEqual({ command: "check", from: "pi-web-fetch" });
  });

  it("parses the --from= spelling", () => {
    expect(parseSyncArguments(["sync", "--from=pi-web-search"])).toEqual({
      command: "sync",
      from: "pi-web-search",
    });
  });

  it("parses the --from X spelling", () => {
    expect(parseSyncArguments(["sync", "--from", "pi-web-search"])).toEqual({
      command: "sync",
      from: "pi-web-search",
    });
  });

  it("rejects an unknown package for --from", () => {
    expect(() => parseSyncArguments(["sync", "--from", "nope"])).toThrow("--from must be one of");
  });

  it.each([
    ["sync", "--from=pi-web-fetch", "--from=pi-web-search"],
    ["sync", "--from=pi-web-fetch=extra"],
    ["sync", "--unknown"],
    ["check", "--from=pi-web-fetch"],
  ])("rejects invalid arguments %j", (...args) => {
    expect(() => parseSyncArguments(args)).toThrow();
  });

  it("rejects an unknown command", () => {
    expect(() => parseSyncArguments(["frobnicate"])).toThrow("unknown command");
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
