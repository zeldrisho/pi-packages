import { CONSUMER_CLIENT, discoverAgyClient, type OAuthClient } from "./agy-client.ts";

/**
 * Public installed-application client shipped by the Antigravity CLI.
 *
 * This is not a user credential and grants no access by itself. It is bundled
 * so sign-in and refresh work without agy, and its SHA-256 fingerprints are
 * asserted in tests. A rotation requires an extension update, or an installed
 * CLI carrying the new pair is preferred automatically.
 */
export const BUNDLED_CLIENT: OAuthClient = {
  id: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
  secret: "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",
};

/**
 * Resolves the OAuth client used for sign-in and refresh.
 *
 * A matching, already-recognized client in an installed agy is preferred, so a
 * known upstream rotation keeps working before an extension update ships. An
 * unknown rotation requires an extension update; otherwise the bundled public
 * client is used. No account token store is read.
 *
 * @param signal - Caller cancellation
 * @returns The client pair to use
 */
export async function resolveOAuthClient(signal?: AbortSignal): Promise<OAuthClient> {
  signal?.throwIfAborted();
  const discovered = await discoverAgyClient(signal, CONSUMER_CLIENT);

  return discovered ?? BUNDLED_CLIENT;
}
