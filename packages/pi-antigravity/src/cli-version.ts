import { runAgy } from "./agy-command.ts";

/**
 * Bundled Antigravity CLI version advertised in the request User-Agent.
 *
 * Verified against the Homebrew cask, which tracks each release:
 * https://github.com/Homebrew/homebrew-cask/blob/master/Casks/a/antigravity-cli.rb
 */
export const DEFAULT_CLI_VERSION = "1.5.9";

/** Probe only the locally installed CLI, without a shell or automatic updates. */
export async function installedCliVersion(signal?: AbortSignal): Promise<string> {
  const output = await runAgy("--version", { timeout: 2_000, maxBuffer: 4_096, signal });
  const version = output?.trim() ?? "";

  return /^\d+\.\d+\.\d+$/.test(version) ? version : DEFAULT_CLI_VERSION;
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
