import { describe, expect, it } from "vite-plus/test";
import { parseSyncArguments } from "../scripts/sync-web-modules.ts";

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

  it("rejects an unknown command", () => {
    expect(() => parseSyncArguments(["frobnicate"])).toThrow("unknown command");
  });
});
