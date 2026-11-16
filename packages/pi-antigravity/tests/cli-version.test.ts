import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_CLI_VERSION,
  parseCliVersion,
  platformTokens,
  resolveCliVersion,
  userAgentFor,
} from "../src/cli-version";

afterEach(() => {
  delete process.env.PI_ANTIGRAVITY_VERSION;
});

describe("version parsing", () => {
  it("reads a bare version", () => {
    expect(parseCliVersion("1.5.9\n")).toBe("1.5.9");
  });

  it("reads a version with a v prefix and a trailing note", () => {
    expect(parseCliVersion("v1.21.9 (build 42)")).toBe("1.21.9");
  });

  it("reads a prerelease version", () => {
    expect(parseCliVersion("1.6.0-beta.2")).toBe("1.6.0-beta.2");
  });

  it("ignores output without a version", () => {
    expect(parseCliVersion("command not found")).toBeUndefined();
    expect(parseCliVersion("")).toBeUndefined();
  });

  it("keeps a verified default for hosts without the CLI", () => {
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
  it("advertises the probed version with the caller's platform", () => {
    const agent = userAgentFor("1.5.9", "darwin", "arm64");

    expect(agent.value).toContain("antigravity/cli/1.5.9");
    expect(agent.value).toContain("os_type=darwin");
    expect(agent.value).toContain("arch=arm64");
    expect(agent.value).toContain("auth_method=consumer");
    expect(agent.cliVersion).toBe("1.5.9");
  });
});

describe("live version probe", () => {
  it("prefers the environment override", async () => {
    process.env.PI_ANTIGRAVITY_VERSION = "9.9.9";

    await expect(resolveCliVersion()).resolves.toBe("9.9.9");
  });

  it("resolves without rejecting when no CLI is installed", async () => {
    const previous = process.env.PATH;

    process.env.PATH = "";

    try {
      await expect(resolveCliVersion()).resolves.toMatch(/^\d+\.\d+\.\d+/);
    } finally {
      process.env.PATH = previous;
    }
  });
});
