import {
  createAssistantMessageEventStream,
  openAICompletionsApi,
  type Model,
} from "@earendil-works/pi-ai/compat";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { applyFingerprintHeaders, buildFingerprintHeaders } from "./fingerprint.ts";
import { isFreeUsageLimitMessage, usageLimitMessage } from "./quota.ts";
import { isProviderRequestPayload, normalizeFreeRequestPayload } from "./request.ts";

/** Delegates protocol handling and retries to Pi while normalizing every provider call. */
export function createFreeStream(
  fetcher: typeof fetch,
  fingerprint: () => { sessionId: string; cliVersion: string },
): NonNullable<ProviderConfig["streamSimple"]> {
  const native = openAICompletionsApi();

  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const { sessionId, cliVersion } = fingerprint();
    const headers = { ...options?.headers, ...buildFingerprintHeaders(sessionId, cliVersion) };
    applyFingerprintHeaders(headers, sessionId, cliVersion);

    const run = async () => {
      try {
        let quotaMessage: string | undefined;
        // SAFETY: this adapter is registered only for the openai-completions API.
        const nativeModel = model as Model<"openai-completions">;

        const inner = native.streamSimple(nativeModel, context, {
          ...options,
          headers,
          onPayload: async (payload, requestModel) => {
            const replacement = await options?.onPayload?.(payload, requestModel);
            const request = replacement === undefined ? payload : replacement;

            return isProviderRequestPayload(request)
              ? normalizeFreeRequestPayload(request)
              : request;
          },
          fetch: async (input, init) => {
            const response = await (options?.fetch ?? fetcher)(input, init);
            quotaMessage =
              response.status === 429 ? usageLimitMessage(response.headers, Date.now()) : undefined;

            return response;
          },
        });

        for await (const event of inner) {
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
