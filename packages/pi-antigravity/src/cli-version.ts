import { execFile } from "node:child_process";

/**
 * Version reported by the Antigravity CLI when the live probe cannot run.
 *
 * Verified against the Homebrew cask, which tracks each release:
 * https://github.com/Homebrew/homebrew-cask/blob/master/Casks/a/antigravity-cli.rb
 */
export const DEFAULT_CLI_VERSION = "1.5.9";

/** An unresponsive or missing CLI must not delay a request. */
const PROBE_TIMEOUT_MS = 2_000;

/** Candidate executable names; the CLI is `antigravity` inside its own bundle. */
const CLI_NAMES = ["agy", "antigravity"] as const;

let probed: Promise<string> | undefined;

/**
 * Reads a version string from CLI output.
 *
 * @param output - stdout from `--version`
 * @returns The version, or undefined when the output carries none
 */
export function parseCliVersion(output: string): string | undefined {
  return /(?:^|\s)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(output.trim())?.[1];
}

/**
 * Runs one CLI candidate and reads its version.
 *
 * @param name - Executable name to try
 * @returns The reported version, or undefined when the executable is missing
 */
function versionFrom(name: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      name,
      ["--version"],
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        resolve(error === null ? parseCliVersion(stdout) : undefined);
      },
    );
  });
}

/**
 * Resolves the CLI version used in the request `User-Agent`.
 *
 * The backend gates model visibility on this string, so a stale pin hides
 * models. `PI_ANTIGRAVITY_VERSION` wins, then the installed CLI, then the
 * verified default. The probe runs once per process.
 *
 * @returns The version string to advertise
 */
export function resolveCliVersion(): Promise<string> {
  const override = process.env.PI_ANTIGRAVITY_VERSION?.trim();

  if (override !== undefined && override !== "") return Promise.resolve(override);

  probed ??= probeFirst();

  return probed;
}

/**
 * Probes each CLI candidate in order.
 *
 * @returns The first reported version, or the verified default
 */
async function probeFirst(): Promise<string> {
  for (const name of CLI_NAMES) {
    const version = await versionFrom(name);

    if (version !== undefined) return version;
  }

  return DEFAULT_CLI_VERSION;
}

/** Platform and architecture tokens the CLI advertises. */
export interface PlatformTokens {
  osType: string;
  arch: string;
}

/**
 * Reports the platform and architecture tokens the CLI advertises.
 *
 * @param platform - Node platform name
 * @param arch - Node architecture name
 * @returns Tokens matching the CLI's own `User-Agent`
 */
export function platformTokens(
  platform: string = process.platform,
  arch: string = process.arch,
): PlatformTokens {
  const osType =
    platform === "darwin" ? "darwin" : platform === "win32" ? "windows" : platform || "linux";

  return { osType, arch: arch === "arm64" ? "arm64" : "amd64" };
}

/** User agent advertised to the backend, with the version it names. */
export interface UserAgent {
  value: string;
  cliVersion: string;
}

/**
 * Builds the `User-Agent` the Antigravity backend expects.
 *
 * @param version - CLI version to advertise
 * @param platform - Node platform name
 * @param arch - Node architecture name
 * @returns The user agent string
 */
export function userAgentFor(version: string, platform?: string, arch?: string): UserAgent {
  const tokens = platformTokens(platform, arch);

  return {
    value:
      `antigravity/cli/${version} (aidev_client; os_type=${tokens.osType}; ` +
      `arch=${tokens.arch}; auth_method=consumer)`,
    cliVersion: version,
  };
}
