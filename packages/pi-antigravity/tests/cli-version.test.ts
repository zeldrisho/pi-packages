import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { DEFAULT_CLI_VERSION, platformTokens, userAgentFor } from "../src/cli-version";
import { antigravityHeaders } from "../src/project";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("version defaults", () => {
  it("keeps a verified bundled default", () => {
    expect(DEFAULT_CLI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("platform tokens", () => {
  it("maps the platforms the backend knows", () => {
    expect(platformTokens("darwin", "arm64")).toEqual({ osType: "darwin", arch: "arm64" });
    expect(platformTokens("linux", "x64")).toEqual({ osType: "linux", arch: "amd64" });
    expect(platformTokens("win32", "x64")).toEqual({ osType: "windows", arch: "amd64" });
  });

  it("falls back to linux rather than emitting an empty token", () => {
    expect(platformTokens("", "ia32")).toEqual({ osType: "linux", arch: "amd64" });
  });
});

describe("user agent", () => {
  it("advertises the selected version with the caller's platform", () => {
    const agent = userAgentFor("1.5.9", "darwin", "arm64");

    expect(agent.value).toContain("antigravity/cli/1.5.9");
    expect(agent.value).toContain("os_type=darwin");
    expect(agent.value).toContain("arch=arm64");
    expect(agent.value).toContain("auth_method=consumer");
    expect(agent.cliVersion).toBe("1.5.9");
  });
});

describe("version resolution", () => {
  it("uses the bundled version rather than the removed version override", async () => {
    vi.stubEnv("PI_ANTIGRAVITY_VERSION", "9.9.9");
    vi.stubEnv("PATH", "");
    expect((await antigravityHeaders("token")).get("user-agent")).toContain(DEFAULT_CLI_VERSION);
  });

  it("uses the installed CLI version", async () => {
    const directory = mkdtempSync(join(tmpdir(), "antigravity-version-"));
    const previous = process.env.PATH;
    writeFileSync(join(directory, "agy"), "#!/bin/sh\nprintf '2.3.4\\n'\n", { mode: 0o755 });
    process.env.PATH = directory;

    try {
      expect((await antigravityHeaders("token")).get("user-agent")).toContain("2.3.4");
    } finally {
      process.env.PATH = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("caches a successful CLI version for the same PATH", async () => {
    const directory = mkdtempSync(join(tmpdir(), "antigravity-version-cache-"));
    const previous = process.env.PATH;
    const binary = join(directory, "agy");
    writeFileSync(binary, "#!/bin/sh\nprintf '2.3.4\\n'\n", { mode: 0o755 });
    process.env.PATH = directory;

    try {
      expect((await antigravityHeaders("token")).get("user-agent")).toContain("2.3.4");
      writeFileSync(binary, "#!/bin/sh\nprintf '3.4.5\\n'\n", { mode: 0o755 });
      expect((await antigravityHeaders("token")).get("user-agent")).toContain("2.3.4");
    } finally {
      process.env.PATH = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("falls back for malformed CLI output", async () => {
    const directory = mkdtempSync(join(tmpdir(), "antigravity-version-"));
    const previous = process.env.PATH;
    writeFileSync(join(directory, "agy"), "#!/bin/sh\nprintf 'not a version\\n'\n", {
      mode: 0o755,
    });
    process.env.PATH = directory;

    try {
      expect((await antigravityHeaders("token")).get("user-agent")).toContain(DEFAULT_CLI_VERSION);
    } finally {
      process.env.PATH = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("honors cancellation before executing the CLI", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(antigravityHeaders("token", controller.signal)).rejects.toThrow("cancelled");
  });

  it("resolves without rejecting when no CLI is installed", async () => {
    const previous = process.env.PATH;

    process.env.PATH = "";

    try {
      expect((await antigravityHeaders("token")).get("user-agent")).toContain(DEFAULT_CLI_VERSION);
    } finally {
      process.env.PATH = previous;
    }
  });
});
