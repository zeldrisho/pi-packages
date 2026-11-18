/**
 * Bundled Antigravity CLI version advertised in the request User-Agent.
 *
 * Sent only as client identification, never as an OAuth input. It is reviewed
 * manually when the upstream client changes rather than resolved at runtime.
 */
export const DEFAULT_CLI_VERSION = "1.5.9";

/**
 * Returns the version advertised to the backend.
 *
 * Requests no longer probe the installed CLI; the bundled version is stable,
 * works without agy, and is reviewed when the upstream client changes.
 *
 * @param signal - Caller cancellation
 * @returns The bundled CLI version
 */
export async function advertisedCliVersion(signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();

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
