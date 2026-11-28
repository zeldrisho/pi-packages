import {
  calculateCost,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type JsonObject,
  type JsonValue,
  type Model,
  type ProviderResponse,
  type SimpleStreamOptions,
  type ToolCall,
  type Usage,
} from "@earendil-works/pi-ai";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { resolveIdentity } from "./ids.ts";
import { isBudgetRoute, overrideThinkingBudget } from "./budget-overrides.ts";
import { ANTIGRAVITY_API, resolveRuntimeModel } from "./models.ts";
import type { createThinkingMetadataResolver } from "./thinking-metadata.ts";
import { isJsonNumber, isJsonObject, isJsonText, parseJsonValue } from "./json.ts";
import { parseApiKey } from "./oauth.ts";
import { ENDPOINTS, antigravityHeaders } from "./project.ts";
import { buildRequest, sanitizeToolCallId, type AntigravityRequestEnvelope } from "./request.ts";

/** Deadline for receiving response headers; transport timeouts are not replayed. */
const HEADER_TIMEOUT_MS = 60_000;

/** Silence allowed inside a stream before it is treated as stalled. */
const STALL_TIMEOUT_MS = 120_000;

/** Attempts made when the provider returns no content. */
const MAX_ATTEMPTS = 3;

/** Stop reasons Pi accepts for a completed response. */
type CompletedStopReason = "stop" | "length" | "toolUse";

/** One decoded content part from the provider stream. */
type StreamPart =
  | { kind: "text"; text: string; signature?: string }
  | { kind: "thinking"; text: string; signature?: string }
  | { kind: "signature"; signature: string }
  | { kind: "toolCall"; name: string; args: JsonObject; id?: string; signature?: string };

/** Token accounting reported by the provider. */
interface StreamUsage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  totalTokens: number;
}

/** One decoded provider chunk. */
export interface StreamChunk {
  parts: StreamPart[];
  finishReason?: string;
  modelVersion?: string;
  responseId?: string;
  usage?: StreamUsage;
  error?: { status?: number; message: string };
}

/**
 * Reads a string field from a decoded chunk.
 *
 * @param value - Field value from a decoded chunk
 * @returns The string, or undefined for other shapes
 */
function asString(value: JsonValue | undefined): string | undefined {
  return isJsonText(value) ? value : undefined;
}

/**
 * Reads a finite number field from a decoded chunk.
 *
 * @param value - Field value from a decoded chunk
 * @returns The number, or undefined for other shapes
 */
function asNumber(value: JsonValue | undefined): number | undefined {
  return isJsonNumber(value) ? value : undefined;
}

/**
 * Reads a boolean field from a decoded chunk.
 *
 * @param value - Field value from a decoded chunk
 * @returns The boolean, or undefined for other shapes
 */
function asBoolean(value: JsonValue | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Decodes one content part.
 *
 * @param value - Part value from a decoded chunk
 * @returns The decoded part, or undefined when it carries nothing usable
 */
function decodePart(value: JsonValue | undefined): StreamPart | undefined {
  if (!isJsonObject(value)) return undefined;

  const part = value;

  const signature = asString(part.thoughtSignature);
  const text = asString(part.text);

  if (text !== undefined && text !== "") {
    const decoded: StreamPart =
      asBoolean(part.thought) === true ? { kind: "thinking", text } : { kind: "text", text };

    if (signature !== undefined) decoded.signature = signature;

    return decoded;
  }

  const call = part.functionCall;

  if (!isJsonObject(call)) {
    return signature === undefined || signature === ""
      ? undefined
      : { kind: "signature", signature };
  }

  const name = asString(call.name);

  if (name === undefined || name === "") return undefined;

  const id = asString(call.id);
  const args = isJsonObject(call.args) ? call.args : {};
  const decoded: StreamPart = { kind: "toolCall", name, args };

  if (id !== undefined) decoded.id = id;

  if (signature !== undefined) decoded.signature = signature;

  return decoded;
}

/**
 * Decodes token accounting.
 *
 * @param value - `usageMetadata` value from a decoded chunk
 * @returns Token counts, or undefined when the payload carries none
 */
function decodeUsage(value: JsonValue | undefined): StreamUsage | undefined {
  if (!isJsonObject(value)) return undefined;

  const usage = value;
  const prompt = asNumber(usage.promptTokenCount) ?? 0;
  const cached = asNumber(usage.cachedContentTokenCount) ?? 0;
  const candidates = asNumber(usage.candidatesTokenCount) ?? 0;
  const thoughts = asNumber(usage.thoughtsTokenCount) ?? 0;

  return {
    input: Math.max(0, prompt - cached),
    output: candidates + thoughts,
    reasoning: thoughts,
    cacheRead: cached,
    totalTokens: asNumber(usage.totalTokenCount) ?? prompt + candidates + thoughts,
  };
}

/**
 * Decodes one `data:` payload into the fields this provider uses.
 *
 * @param text - JSON text from the provider stream
 * @returns The decoded chunk, or undefined when the payload is not a chunk
 */
export function decodeChunk(text: string): StreamChunk | undefined {
  let parsed: JsonValue;

  try {
    parsed = parseJsonValue(text);
  } catch {
    return undefined;
  }

  if (!isJsonObject(parsed)) return undefined;

  const error = parsed.error;

  if (isJsonObject(error)) {
    const status = asNumber(error.code);
    const message = asString(error.message) ?? "Antigravity request failed";
    const failure: StreamChunk = { parts: [], error: { message } };

    if (status !== undefined) failure.error = { status, message };

    return failure;
  }

  const payload = isJsonObject(parsed.response) ? parsed.response : parsed;
  const candidates = payload.candidates;
  const first = Array.isArray(candidates) ? candidates[0] : undefined;
  const content = isJsonObject(first) ? first.content : undefined;
  const rawParts = isJsonObject(content) ? content.parts : undefined;
  const parts: StreamPart[] = [];

  if (Array.isArray(rawParts)) {
    for (const raw of rawParts) {
      const part = decodePart(raw);

      if (part !== undefined) parts.push(part);
    }
  }

  const chunk: StreamChunk = { parts };
  const finishReason = isJsonObject(first) ? asString(first.finishReason) : undefined;
  const modelVersion = asString(payload.modelVersion);
  const responseId = asString(payload.responseId);
  const usage = decodeUsage(payload.usageMetadata);

  if (finishReason !== undefined) chunk.finishReason = finishReason;

  if (modelVersion !== undefined) chunk.modelVersion = modelVersion;

  if (responseId !== undefined) chunk.responseId = responseId;

  if (usage !== undefined) chunk.usage = usage;

  return chunk;
}

/**
 * Describes a failed HTTP response without echoing credentials.
 *
 * @param status - HTTP status code
 * @param body - Response body, bounded here before use
 * @returns A user-facing message
 */
type ExhaustionKind = "quota" | "restriction" | "temporary" | "unknown";

type ProviderReason = "quota" | "rateLimit" | "capacity" | "tos" | "restriction";

/** Reads Google RPC ErrorInfo reasons without trusting arbitrary provider text. */
function providerReasons(body: string): Set<ProviderReason> {
  const reasons = new Set<ProviderReason>();

  try {
    const parsed = parseJsonValue(body.slice(0, 16_384));
    const error = isJsonObject(parsed) ? parsed.error : undefined;
    const details = isJsonObject(error) && Array.isArray(error.details) ? error.details : [];

    for (const detail of details) {
      if (!isJsonObject(detail) || !isJsonText(detail.reason)) continue;
      const reason = detail.reason.toUpperCase();

      if (reason === "QUOTA_EXHAUSTED" || reason === "INSUFFICIENT_G1_CREDITS_BALANCE")
        reasons.add("quota");
      else if (reason === "RATE_LIMIT_EXCEEDED") reasons.add("rateLimit");
      else if (reason === "MODEL_CAPACITY_EXHAUSTED") reasons.add("capacity");
      else if (reason === "TOS_VIOLATION") reasons.add("tos");
      else if (reason === "PERMISSION_DENIED") reasons.add("restriction");
    }
  } catch {
    // Text matching below remains a bounded fallback for non-JSON responses.
  }

  return reasons;
}

/** Classify only explicit provider signals; a generic resource exhaustion is ambiguous. */
function exhaustionKind(body: string): ExhaustionKind {
  const reasons = providerReasons(body);
  const text = body.slice(0, 16_384);

  if (reasons.has("quota")) return "quota";

  if (reasons.has("tos") || reasons.has("restriction")) return "restriction";

  if (reasons.has("rateLimit") || reasons.has("capacity")) return "temporary";

  if (
    /insufficient_quota|quota[_\s-]+exceeded|usage[_\s-]+limit[_\s-]+(?:reached|exceeded)|(?:daily|weekly|monthly)\s+(?:usage\s+)?(?:quota|limit)/i.test(
      text,
    )
  )
    return "quota";

  if (/account[_\s-]+(?:restricted|suspended|disabled)|permission[_\s-]+denied/i.test(text))
    return "restriction";

  if (
    /server[_\s-]+busy|temporarily\s+unavailable|model\s+is\s+at\s+capacity|rate[_\s-]+limit(?:ed|ing)?|too\s+many\s+requests/i.test(
      text,
    )
  )
    return "temporary";

  return "unknown";
}

export function describeFailure(status: number, body: string): string {
  const reasons = providerReasons(body);

  if (status === 403 && reasons.has("tos"))
    return "Antigravity suspended this account for a Terms of Service violation. Review the provider notice or appeal; signing in again will not resolve the suspension.";

  if (status === 429 && reasons.has("quota"))
    return "Antigravity usage quota exceeded. Wait for it to reset or select another model.";

  if ((status === 429 || status === 503) && reasons.has("capacity"))
    return "Antigravity has no capacity available for the selected model. Try another model or thinking level, or wait and retry.";

  if (status === 429 && reasons.has("rateLimit"))
    return "Antigravity is rate limiting this account. Wait and retry, or select another model.";
  const detail = body.replace(/\s+/g, " ").trim().slice(0, 300);
  const suffix = detail === "" ? "" : `: ${detail}`;

  if (status === 401 || status === 403) {
    return `Antigravity denied access for this account (${status}${suffix}). Re-run /login antigravity or use an account with access.`;
  }

  if (status === 404) {
    return `Antigravity does not offer this model to the signed-in account (404${suffix}). Select another model with /model.`;
  }

  if (
    status === 503 &&
    (reasons.has("capacity") ||
      /\bMODEL_CAPACITY_EXHAUSTED\b|\bno capacity available for model\b/i.test(
        body.slice(0, 16_384),
      ))
  ) {
    return "Antigravity has no capacity available for the selected model. Try another model or thinking level, or wait and retry.";
  }

  if (status === 429) {
    const kind = exhaustionKind(body);

    if (kind === "quota")
      return "Antigravity usage quota exceeded. Wait for it to reset or select another model.";

    if (kind === "restriction")
      return "Antigravity reports an account restriction. Check account access or select another model.";

    if (kind === "temporary")
      return "Antigravity is temporarily unavailable due to capacity or rate limiting. Try again later or select another model.";

    return "Antigravity rejected the request: resource exhausted. The service did not specify whether this is a usage limit, temporary capacity issue, or account restriction. Try later or select another model.";
  }

  return `Antigravity request failed (${status}${suffix}).`;
}

/**
 * Maps a provider finish reason to a Pi stop reason.
 *
 * @param reason - Provider finish reason
 * @returns The Pi stop reason, or undefined when the value is unknown
 */
function mapFinishReason(reason: string): CompletedStopReason | undefined {
  if (reason === "STOP") return "stop";

  if (reason === "MAX_TOKENS") return "length";

  return undefined;
}

/**
 * Creates the assistant message skeleton for one request.
 *
 * @param model - Provider model used for the request
 * @returns An empty assistant message with zeroed usage
 */
function emptyMessage(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: ANTIGRAVITY_API,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    timestamp: Date.now(),
  };
}

/**
 * Applies provider usage to the assistant message.
 *
 * @param output - Assistant message being built
 * @param model - Provider model, used for cost calculation
 * @param usage - Provider-reported token counts
 */
function applyUsage(output: AssistantMessage, model: Model<Api>, usage: StreamUsage): void {
  const next: Usage = {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: 0,
    reasoning: usage.reasoning,
    totalTokens: usage.totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };

  next.cost = calculateCost(model, next);
  output.usage = next;
}

/** Live text or thinking block being assembled from streamed parts. */
interface ActiveBlock {
  type: "text" | "thinking";
  content: string;
  signature?: string;
}

/** Mutable state for one stream consumption. */
interface ConsumptionState {
  active?: ActiveBlock;
  sawFinishReason: boolean;
  receivedContent: boolean;
  started: boolean;
  /** Signature from the part that preceded the current one, if any. */
  lastSignature?: string;
  stopReason?: CompletedStopReason;
}

/**
 * Emits the closing event for the live block.
 *
 * @param stream - Pi stream receiving events
 * @param output - Assistant message being built
 * @param state - Consumption state holding the live block
 */
function finishActive(
  stream: AssistantMessageEventStream,
  output: AssistantMessage,
  state: ConsumptionState,
): void {
  const active = state.active;

  if (active === undefined) return;

  state.active = undefined;

  const block = output.content.at(-1);

  if (block?.type === "text") block.textSignature = active.signature;

  if (block?.type === "thinking") block.thinkingSignature = active.signature;

  stream.push(
    active.type === "thinking"
      ? {
          type: "thinking_end",
          contentIndex: output.content.length - 1,
          content: active.content,
          partial: output,
        }
      : {
          type: "text_end",
          contentIndex: output.content.length - 1,
          content: active.content,
          partial: output,
        },
  );
}

/**
 * Appends one decoded part, emitting the matching Pi events.
 *
 * @param part - Decoded provider part
 * @param stream - Pi stream receiving events
 * @param output - Assistant message being built
 * @param state - Consumption state
 */
function appendPart(
  part: StreamPart,
  stream: AssistantMessageEventStream,
  output: AssistantMessage,
  state: ConsumptionState,
): void {
  const ensureStarted = (): void => {
    if (state.started) return;

    state.started = true;
    stream.push({ type: "start", partial: output });
  };

  if (part.kind === "signature") {
    state.lastSignature = part.signature;

    if (state.active !== undefined) state.active.signature = part.signature;

    return;
  }

  state.receivedContent = true;

  if (part.kind === "toolCall") {
    finishActive(stream, output, state);

    // Gemini 3 can attach the signature to the text part before a call, so the
    // call inherits it; a replay without any signature is rejected upstream.
    const signature = part.signature ?? state.lastSignature;

    const baseId = sanitizeToolCallId(sanitizeToolCallId(part.id ?? "", part.name), "tool");

    const usedIds = new Set(
      output.content.flatMap((item) => (item.type === "toolCall" ? [item.id] : [])),
    );

    let id = baseId;

    for (let index = 2; usedIds.has(id); index += 1) {
      const suffix = `_${index}`;
      id = `${baseId.slice(0, 64 - suffix.length)}${suffix}`;
    }

    const toolCall: ToolCall = {
      type: "toolCall",
      id,
      name: part.name,
      arguments: part.args,
    };

    if (signature !== undefined) toolCall.thoughtSignature = signature;

    const contentIndex = output.content.length;

    output.content.push(toolCall);
    ensureStarted();
    stream.push({ type: "toolcall_start", contentIndex, partial: output });
    stream.push({
      type: "toolcall_delta",
      contentIndex,
      delta: JSON.stringify(toolCall.arguments),
      partial: output,
    });
    stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });

    return;
  }

  if (part.signature !== undefined) state.lastSignature = part.signature;

  const active = state.active;

  if (active === undefined || active.type !== part.kind) {
    finishActive(stream, output, state);

    const next: ActiveBlock = { type: part.kind, content: part.text };

    if (part.signature !== undefined) next.signature = part.signature;

    state.active = next;
    output.content.push(
      next.type === "thinking" ? { type: "thinking", thinking: "" } : { type: "text", text: "" },
    );

    const contentIndex = output.content.length - 1;

    ensureStarted();
    stream.push(
      next.type === "thinking"
        ? { type: "thinking_start", contentIndex, partial: output }
        : { type: "text_start", contentIndex, partial: output },
    );
    stream.push(
      next.type === "thinking"
        ? { type: "thinking_delta", contentIndex, delta: part.text, partial: output }
        : { type: "text_delta", contentIndex, delta: part.text, partial: output },
    );

    const block = output.content[contentIndex];

    if (block?.type === "text") block.text = next.content;

    if (block?.type === "thinking") block.thinking = next.content;

    return;
  }

  active.content += part.text;

  if (part.signature !== undefined) active.signature = part.signature;

  const block = output.content.at(-1);

  if (block?.type === "text") block.text = active.content;

  if (block?.type === "thinking") block.thinking = active.content;

  stream.push(
    active.type === "thinking"
      ? {
          type: "thinking_delta",
          contentIndex: output.content.length - 1,
          delta: part.text,
          partial: output,
        }
      : {
          type: "text_delta",
          contentIndex: output.content.length - 1,
          delta: part.text,
          partial: output,
        },
  );
}

/**
 * Times out a promise when the provider stops sending data.
 *
 * @param pending - Read in progress
 * @param stallMs - Silence allowed before the read fails
 * @param onStall - Called before the read is rejected
 * @returns The read result
 */
async function withStallDeadline<T>(
  pending: Promise<T>,
  stallMs: number,
  onStall: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onStall();
      // "timed out" keeps this on Pi's retryable-error list.
      reject(new Error(`Antigravity stream stalled for ${stallMs}ms (timed out)`));
    }, stallMs);
  });

  try {
    return await Promise.race([pending, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Context shared by the per-line stream handler. */
interface StreamContext {
  stream: AssistantMessageEventStream;
  output: AssistantMessage;
  model: Model<Api>;
  state: ConsumptionState;
  options: SimpleStreamOptions | undefined;
}

/**
 * Handles one SSE line.
 *
 * @param line - Line from the response body
 * @param context - Stream context
 * @throws If the provider reports an error chunk
 */
async function handleEvent(dataLines: readonly string[], context: StreamContext): Promise<void> {
  if (dataLines.length === 0) return;

  const payload = dataLines.join("\n").trim();

  if (payload === "" || payload === "[DONE]") return;

  const chunk = decodeChunk(payload);

  if (chunk === undefined) return;

  if (chunk.error !== undefined) {
    throw new Error(
      describeFailure(
        chunk.error.status ?? 500,
        chunk.error.status === 403 || chunk.error.status === 429 || chunk.error.status === 503
          ? payload
          : chunk.error.message,
      ),
    );
  }

  await context.options?.onProviderStreamEvent?.(chunk, context.model);

  if (chunk.modelVersion !== undefined) context.output.responseModel = chunk.modelVersion;

  if (chunk.responseId !== undefined) context.output.responseId = chunk.responseId;

  for (const part of chunk.parts) appendPart(part, context.stream, context.output, context.state);

  if (chunk.finishReason !== undefined) {
    context.state.sawFinishReason = true;
    context.output.rawStopReason = chunk.finishReason;
    context.state.stopReason = context.output.content.some((block) => block.type === "toolCall")
      ? "toolUse"
      : mapFinishReason(chunk.finishReason);
  }

  if (chunk.usage !== undefined) applyUsage(context.output, context.model, chunk.usage);
}

/**
 * Consumes one SSE response body.
 *
 * @param response - Successful HTTP response with an SSE body
 * @param context - Stream context
 * @throws If the provider reports an error, stalls, or ends without a finish reason
 */
async function consumeStream(response: Response, context: StreamContext): Promise<void> {
  if (response.body === null) throw new Error("Antigravity returned an empty response body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];

  const consumeLine = async (line: string): Promise<void> => {
    if (line === "") {
      await handleEvent(dataLines, context);
      dataLines = [];

      return;
    }

    if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).replace(/^ /, ""));
  };

  try {
    while (true) {
      const result = await withStallDeadline(reader.read(), STALL_TIMEOUT_MS, () => {
        void reader.cancel().catch(() => {});
      });

      if (result.done === true) break;

      if (!(result.value instanceof Uint8Array)) continue;

      buffer += decoder.decode(result.value, { stream: true });

      let newline = buffer.indexOf("\n");

      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");

        buffer = buffer.slice(newline + 1);
        await consumeLine(line);
        newline = buffer.indexOf("\n");
      }
    }

    buffer += decoder.decode();

    if (buffer !== "") await consumeLine(buffer.replace(/\r$/, ""));
    await handleEvent(dataLines, context);
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  finishActive(context.stream, context.output, context.state);

  if (!context.state.sawFinishReason) {
    throw new Error("Antigravity stream ended without a finish reason (timed out)");
  }
}

/** Caller response instrumentation signature. */
type ResponseObserver = (
  response: { status: number; headers: Record<string, string> },
  model: Model<Api>,
) => void | Promise<void>;

/** Response headers converted for Pi's response hook. */
function headerRecord(headers: Headers): ProviderResponse["headers"] {
  return Object.fromEntries(headers.entries());
}

/**
 * Sends one request, falling back to the next endpoint only on explicit
 * temporary capacity rejections.
 *
 * @param envelope - Request body to send
 * @param token - OAuth access token
 * @param signal - Caller cancellation
 * @param onResponse - Pi's response hook
 * @returns The successful response
 * @throws With the failure that describes why no endpoint succeeded
 */
async function postToEndpoint(
  envelope: AntigravityRequestEnvelope,
  token: string,
  signal: AbortSignal | undefined,
  onResponse: ResponseObserver | undefined,
  model: Model<Api>,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<Response> {
  const body = JSON.stringify(envelope);
  let lastError: Error | undefined;

  const headers = await antigravityHeaders(token, signal);

  for (const endpoint of ENDPOINTS) {
    const controller = new AbortController();

    const timer = setTimeout(
      () => controller.abort(new Error("Antigravity timed out waiting for response headers")),
      HEADER_TIMEOUT_MS,
    );

    const combined =
      signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);

    let response: Response;

    try {
      response = await fetcher(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
        method: "POST",
        headers,
        body,
        redirect: "error",
        signal: combined,
      });
    } finally {
      clearTimeout(timer);
    }

    await onResponse?.({ status: response.status, headers: headerRecord(response.headers) }, model);

    if (response.ok) return response;

    const failureBody = await response.text();
    const failure = new Error(describeFailure(response.status, failureBody));

    // Only explicit transient capacity signals justify another endpoint.
    if (response.status === 429 && exhaustionKind(failureBody) === "temporary") {
      lastError = failure;
      continue;
    }

    throw failure;
  }

  throw lastError ?? new Error("Antigravity request failed for every endpoint");
}

/**
 * Re-types a payload returned by Pi's payload hook.
 *
 * @param value - Replacement payload from the hook
 * @returns The replacement as this provider's envelope
 */
function asEnvelope(value: unknown): AntigravityRequestEnvelope {
  // SAFETY: Pi's payload hook contract replaces the provider payload for the same request.
  return value as AntigravityRequestEnvelope;
}

/**
 * Creates the provider's streaming implementation.
 *
 * @returns A `streamSimple` handler for the `antigravity` API
 */
export function createAntigravityStream(
  resolveThinking?: ReturnType<typeof createThinkingMetadataResolver>,
): NonNullable<ProviderConfig["streamSimple"]> {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();

    void (async () => {
      const output = emptyMessage(model);

      try {
        options?.signal?.throwIfAborted();

        const credentials = parseApiKey(options?.apiKey);
        const entry = { ...model, thinkingLevelMap: model.thinkingLevelMap ?? {} };
        const runtimeModel = resolveRuntimeModel(entry, options?.reasoning);

        // Resolve account-advertised thinking metadata whenever reasoning is requested;
        // the local route configuration remains the fallback when discovery is unavailable.
        const liveThinkingMetadataNeeded =
          options?.reasoning !== undefined && String(options.reasoning) !== "off";

        const discoveredThinkingConfig = liveThinkingMetadataNeeded
          ? await resolveThinking?.(
              credentials.token,
              credentials.projectId,
              runtimeModel,
              options.signal,
              options.fetch,
            )
          : undefined;

        const selectedThinkingConfig = overrideThinkingBudget({
          enabled: isBudgetRoute(entry.thinkingLevelMap, runtimeModel),
          level: options?.reasoning,
          budgets: options?.thinkingBudgets,
          advertised: discoveredThinkingConfig,
          maxOutputTokens: Math.min(options?.maxTokens ?? model.maxTokens, model.maxTokens),
        });

        const identity = resolveIdentity(options?.sessionId);

        const requestIndex = context.messages.filter(
          (message) =>
            message.role === "assistant" &&
            message.stopReason !== "error" &&
            message.stopReason !== "aborted",
        ).length;

        let lastEmpty: Error | undefined;

        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
          if (attempt > 0)
            await new Promise((resolve) => {
              setTimeout(resolve, 500 * attempt);
            });

          const envelope = buildRequest({
            model: entry,
            messages: context.messages,
            systemPrompt: getCurrentSystemPrompt(context.messages),
            tools: getCurrentTools(context.messages),
            projectId: credentials.projectId,
            runtimeModel,
            identity,
            requestIndex,
            now: Date.now(),
            maxTokens: options?.maxTokens,
            temperature: options?.temperature,
            thinkingLevel: options?.reasoning,
            discoveredThinkingConfig: selectedThinkingConfig,
          });

          const rewritten = await options?.onPayload?.(envelope, model);
          const payload = rewritten === undefined ? envelope : asEnvelope(rewritten);

          const response = await postToEndpoint(
            payload,
            credentials.token,
            options?.signal,
            options?.onResponse,
            model,
            options?.fetch,
          );

          output.content = [];
          output.stopReason = "pending";

          const streamContext: StreamContext = {
            stream,
            output,
            model,
            state: { sawFinishReason: false, receivedContent: false, started: false },
            options,
          };

          await consumeStream(response, streamContext);

          if (!streamContext.state.receivedContent) {
            lastEmpty = new Error("Antigravity returned an empty response");
            continue;
          }

          const stopReason = streamContext.state.stopReason;

          output.thinkingLevel = options?.reasoning;
          output.providerThinkingLevel = runtimeModel;

          if (stopReason === undefined) {
            throw new Error(
              `Antigravity stopped with an unrecognized reason: ${output.rawStopReason ?? "none"}`,
            );
          }

          output.stopReason = stopReason;

          stream.push({ type: "done", reason: stopReason, message: output });
          stream.end();

          return;
        }

        throw lastEmpty ?? new Error("Antigravity returned an empty response");
      } catch (error) {
        output.stopReason = options?.signal?.aborted === true ? "aborted" : "error";
        output.errorMessage = error instanceof Error ? error.message : String(error);
        stream.push({ type: "error", reason: output.stopReason, error: output });
        stream.end();
      }
    })();

    return stream;
  };
}
