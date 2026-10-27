import {
  createAssistantMessageEventStream,
  openAICompletionsApi,
  type Model,
} from "@earendil-works/pi-ai/compat";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { BunTransportError } from "./bun-transport.ts";
import { applyClientHeaders, buildClientHeaders } from "./client-headers.ts";
import { isFreeUsageLimitMessage, usageLimitMessage } from "./quota.ts";
import { isProviderRequestPayload, normalizeFreeRequestPayload } from "./request.ts";

/**
 * Delegates protocol handling and retries to Pi while normalizing every provider call.
 * Resolves the client identity for each call and normalizes recognized payloads after
 * the caller's payload hook. Caller fetch overrides and instrumentation are preserved.
 * Confirmed free-usage 429 errors receive a notice using the response's Retry-After.
 *
 * @param fetcher - Transport used when the caller supplies none
 * @param identity - Resolves the session identity and client version per call
 * @param resolveWorkingDirectory - Declares the request's working directory to the gateway
 * @returns A streaming callback that forwards native events and converts setup,
 *   identity resolution, or forwarding failures into error events before closing the stream;
 *   an aborted caller signal marks those failures as aborted
 */
export function createFreeStream(
  fetcher: typeof fetch,
  identity: (
    signal?: AbortSignal,
  ) =>
    | { sessionId: string; cliVersion: string }
    | Promise<{ sessionId: string; cliVersion: string }>,
  resolveWorkingDirectory: () => string = () => process.cwd(),
): NonNullable<ProviderConfig["streamSimple"]> {
  const native = openAICompletionsApi();

  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();

    const run = async () => {
      try {
        options?.signal?.throwIfAborted();
        const { sessionId, cliVersion } = await identity(options?.signal);
        options?.signal?.throwIfAborted();
        const headers = { ...options?.headers, ...buildClientHeaders(sessionId, cliVersion) };
        applyClientHeaders(headers, sessionId, cliVersion);
        let quotaMessage: string | undefined;
        let transportMessage: string | undefined;
        // SAFETY: this adapter is registered only for the openai-completions API.
        const nativeModel = model as Model<"openai-completions">;

        const inner = native.streamSimple(nativeModel, context, {
          ...options,
          headers,
          onPayload: async (payload, requestModel) => {
            const replacement = await options?.onPayload?.(payload, requestModel);
            const request = replacement === undefined ? payload : replacement;

            return isProviderRequestPayload(request)
              ? normalizeFreeRequestPayload(request, resolveWorkingDirectory())
              : request;
          },
          fetch: async (input, init) => {
            transportMessage = undefined;

            try {
              const response = await (options?.fetch ?? fetcher)(input, init);
              quotaMessage =
                response.status === 429
                  ? usageLimitMessage(response.headers, Date.now())
                  : undefined;

              return response;
            } catch (error) {
              if (error instanceof BunTransportError) transportMessage = error.message;
              throw error;
            }
          },
        });

        for await (const event of inner) {
          if (event.type === "error" && event.reason !== "aborted" && transportMessage) {
            event.error.errorMessage = transportMessage;
          }

          if (
            event.type === "error" &&
            event.reason !== "aborted" &&
            quotaMessage &&
            isFreeUsageLimitMessage(event.error.errorMessage)
          ) {
            event.error.errorMessage = quotaMessage;
          }

          stream.push(event);
        }
      } catch (error) {
        stream.push({
          type: "error",
          reason: options?.signal?.aborted ? "aborted" : "error",
          error: {
            role: "assistant",
            api: model.api,
            provider: model.provider,
            model: model.id,
            content: [],
            timestamp: Date.now(),
            stopReason: options?.signal?.aborted ? "aborted" : "error",
            errorMessage: error instanceof Error ? error.message : String(error),
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          },
        });
      } finally {
        stream.end();
      }
    };

    void run();

    return stream;
  };
}
