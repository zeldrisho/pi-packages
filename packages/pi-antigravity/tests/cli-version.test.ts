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
  it("advertises the bundled version without probing the CLI", async () => {
    vi.stubEnv("PATH", "");

    expect((await antigravityHeaders("token")).get("user-agent")).toContain(DEFAULT_CLI_VERSION);
  });

  it("honors cancellation", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));

    await expect(antigravityHeaders("token", controller.signal)).rejects.toThrow("cancelled");
  });
});
