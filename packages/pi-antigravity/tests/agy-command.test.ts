import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { runAgy } from "../src/agy-command";

describe("agy subprocess", () => {
  it("bounds output and times out a stuck process", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agy-command-"));
    const path = process.env.PATH;
    process.env.PATH = dir;

    try {
      writeFileSync(join(dir, "agy"), "#!/bin/sh\nprintf '1234567890'\n", { mode: 0o755 });
      expect(await runAgy("models", { timeout: 1000, maxBuffer: 4 })).toBeUndefined();
      writeFileSync(join(dir, "agy"), "#!/bin/sh\nexec /bin/sleep 10\n", { mode: 0o755 });
      expect(await runAgy("models", { timeout: 50, maxBuffer: 100 })).toBeUndefined();
    } finally {
      process.env.PATH = path;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("aborts an active subprocess", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agy-command-"));
    const path = process.env.PATH;
    process.env.PATH = dir;
    const controller = new AbortController();

    try {
      writeFileSync(join(dir, "agy"), "#!/bin/sh\nexec /bin/sleep 10\n", { mode: 0o755 });
      const result = runAgy("models", { timeout: 5000, maxBuffer: 100, signal: controller.signal });
      setTimeout(() => controller.abort(new Error("cancelled")), 50);
      await expect(result).rejects.toThrow("cancelled");
    } finally {
      process.env.PATH = path;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
