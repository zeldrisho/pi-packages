import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { capture, compare, parseSnapshot } from "../scripts/compatibility.ts";

describe("compatibility inventory", () => {
  it("captures bounded literal presence across chunks without exposing artifact contents", async () => {
    const dir = await mkdtemp(join(tmpdir(), "compatibility-test-"));

    try {
      const path = join(dir, "artifact");
      await writeFile(
        path,
        Buffer.concat([
          Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
          Buffer.alloc(1024 * 1024 - 8),
          Buffer.from("x-opencode-session secret-value"),
        ]),
      );
      const snapshot = await capture("opencode", path);
      expect(snapshot.format).toBe("elf");
      expect(snapshot.markers["x-opencode-session"]).toBe(true);
      expect(JSON.stringify(snapshot)).not.toContain("secret-value");
      expect(parseSnapshot(JSON.stringify(snapshot))).toEqual(snapshot);
      const changed = await capture("antigravity", path);
      expect(() => compare(snapshot, changed)).toThrow();
      const later = { ...snapshot, markers: { ...snapshot.markers, "x-opencode-session": false } };
      expect(compare(snapshot, later)).toContain("x-opencode-session: true -> false");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed snapshots and unsupported providers", async () => {
    expect(() => parseSnapshot('{"schema":1}')).toThrow();
    expect(() => parseSnapshot("null")).toThrow();
    await expect(capture("other", "unused")).rejects.toThrow();
  });
});
