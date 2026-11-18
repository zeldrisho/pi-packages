import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { discoverAgyClient, scanClientBinary, type ClientFingerprints } from "../src/agy-client";
import { resolveOAuthClient } from "../src/oauth";

const id = `123456789012-${"a".repeat(32)}.apps.googleusercontent.com`;

const secret = `GOCSPX-${"b".repeat(28)}`;

const otherSecret = `GOCSPX-${"c".repeat(28)}`;

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

const expected: ClientFingerprints = { id: hash(id), secrets: [hash(secret)] };

const paths: string[] = [];

async function fixture(content: Buffer): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-agy-client-test-"));
  paths.push(directory);
  const path = join(directory, "agy");
  await writeFile(path, content, { mode: 0o700 });

  return path;
}

function elf(contents: string): Buffer {
  return Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from(contents)]);
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("installed CLI OAuth client discovery", () => {
  it("selects only fingerprint-matched credentials from glued binary strings", async () => {
    const path = await fixture(elf(`padding${id}tail\0${secret}extra\0`));
    expect(await scanClientBinary(path, expected)).toEqual({ id, secret });
  });

  it("finds credentials crossing a chunk boundary", async () => {
    const prefix = "x".repeat(1024 * 1024 - 20);
    const path = await fixture(elf(`${prefix}${id}\0${secret}\0`));
    expect(await scanClientBinary(path, expected)).toEqual({ id, secret });
  });

  it("rejects ambiguous matching secrets and unrecognized clients", async () => {
    const path = await fixture(elf(`${id}\0${secret}\0${otherSecret}\0`));
    expect(
      await scanClientBinary(path, { ...expected, secrets: [hash(secret), hash(otherSecret)] }),
    ).toBeUndefined();
    expect(await scanClientBinary(path, { ...expected, id: hash("unknown") })).toBeUndefined();
  });

  it("rejects scripts and missing binaries without exposing paths", async () => {
    const path = await fixture(Buffer.from(`#!/bin/sh\n${id}\n${secret}`));
    expect(await scanClientBinary(path, expected)).toBeUndefined();
    vi.stubEnv("PATH", dirname(path));
    expect(await discoverAgyClient()).toBeUndefined();
    await expect(resolveOAuthClient()).rejects.toThrow(/Could not identify/);
  });

  it("discovers a native binary on PATH", async () => {
    const path = await fixture(elf(`${id}\0${secret}\0`));
    vi.stubEnv("PATH", dirname(path));

    expect(await discoverAgyClient(undefined, expected)).toEqual({ id, secret });
  });

  it("resolves a Homebrew wrapper without executing it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-agy-client-test-"));
    paths.push(directory);
    const binary = join(directory, "antigravity");
    const wrappers = join(directory, ".homebrew-command-wrappers");
    await mkdir(wrappers);
    await writeFile(binary, elf(`${id}\0${secret}\0`), { mode: 0o700 });
    const wrapper = join(wrappers, "agy");
    await writeFile(
      wrapper,
      `#!/bin/bash\nAGY_CLI_DISABLE_AUTO_UPDATE="true" exec "${binary}"  "$@"\n`,
      { mode: 0o700 },
    );
    const link = join(directory, "agy");
    await symlink(wrapper, link);
    vi.stubEnv("PATH", dirname(link));

    expect(await discoverAgyClient(undefined, expected)).toEqual({ id, secret });
  });

  it("rejects a wrapper whose target escapes its installation directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-agy-client-test-"));
    paths.push(directory);
    const wrappers = join(directory, ".homebrew-command-wrappers");
    await mkdir(wrappers);
    const wrapper = join(wrappers, "agy");
    await writeFile(
      wrapper,
      '#!/bin/bash\nAGY_CLI_DISABLE_AUTO_UPDATE="true" exec "/tmp/antigravity"  "$@"\n',
      { mode: 0o700 },
    );
    vi.stubEnv("PATH", dirname(wrapper));
    expect(await discoverAgyClient(undefined, expected)).toBeUndefined();
  });

  it("honors cancellation before scanning and rejects excessive candidates", async () => {
    const path = await fixture(elf(`${id}\0${secret}\0`));
    const controller = new AbortController();
    controller.abort();
    await expect(scanClientBinary(path, expected, controller.signal)).rejects.toThrow();
    vi.stubEnv("PATH", dirname(path));
    await expect(discoverAgyClient(controller.signal)).rejects.toThrow();
    const malformed = await fixture(elf(`${secret}\0`.repeat(2100)));
    expect(await scanClientBinary(malformed, expected)).toBeUndefined();
  });
});
