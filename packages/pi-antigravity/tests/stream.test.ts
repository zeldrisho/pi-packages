import {
  normalizeContext,
  type AssistantMessage,
  type JsonObject,
  type Model,
} from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { getApiKey } from "../src/oauth";
import { createAntigravityStream, decodeChunk, describeFailure } from "../src/stream";

const API_KEY = getApiKey({
  access: "access-token",
  refresh: "refresh-token",
  expires: 0,
  projectId: "project-under-test",
});

const streamModel: Model<"antigravity"> = {
  id: "gemini-3.8-flash",
  name: "Gemini 3.8 Flash (Antigravity)",
  api: "antigravity",
  provider: "antigravity",
  baseUrl: "https://daily-cloudcode-pa.googleapis.com",
  input: ["text", "image"],
  reasoning: true,
  thinkingLevelMap: { medium: "gemini-3.8-flash-medium" },
  contextWindow: 1_048_576,
  maxTokens: 65_536,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function sse(frames: readonly string[]): Response {
  const body = frames.map((frame) => `data: ${frame}\n\n`).join("");

  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function textFrame(text: string, extra: JsonObject = {}): string {
  return JSON.stringify({
    response: {
      candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
      ...extra,
    },
  });
}

function contextWith(prompt: string, systemPrompt = "You are terse.") {
  return normalizeContext({
    systemPrompt,
    messages: [{ role: "user", content: prompt, timestamp: 1 }],
  });
}

async function collect(frames: readonly string[]) {
  vi.stubGlobal("fetch", async () => sse(frames));

  const stream = createAntigravityStream()(streamModel, contextWith("Bake bread"), {
    apiKey: API_KEY,
    sessionId: "stream-session",
  });

  const types: string[] = [];
  let final: AssistantMessage | undefined;

  for await (const event of stream) {
    types.push(event.type);

    if (event.type === "done") final = event.message;

    if (event.type === "error") final = event.error;
  }

  return { types, final };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("discovered model routing", () => {
  it("sends a configured Pi budget instead of the advertised default", async () => {
    let requestBody = "";
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- provider sends a serialized JSON body
      requestBody = typeof init.body === "string" ? init.body : "";

      return sse([textFrame("OK")]);
    });

    const model = {
      ...streamModel,
      thinkingLevelMap: {
        minimal: "budget-runtime",
        low: "budget-runtime",
        medium: "budget-runtime",
        high: "budget-runtime",
        xhigh: null,
        max: null,
      },
    };

    const resolver = vi.fn(async () => ({ includeThoughts: true, thinkingBudget: 1024 }));

    const result = await createAntigravityStream(resolver)(model, contextWith("Hi"), {
      apiKey: API_KEY,
      reasoning: "high",
      thinkingBudgets: { high: 8192 },
      maxTokens: 10000,
    }).result();

    expect(result.stopReason).toBe("stop");
    expect(JSON.parse(requestBody).request.generationConfig.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingBudget: 8192,
    });
  });

  it("uses the selected model's runtime mapping and limits, including models absent from the seed", async () => {
    let requestBody = "";

    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- provider sends a serialized JSON body
      requestBody = typeof init.body === "string" ? init.body : "";

      return sse([textFrame("OK")]);
    });

    const model: Model<"antigravity"> = {
      ...streamModel,
      id: "new-model",
      maxTokens: 1234,
      thinkingLevelMap: { medium: "new-model-medium" },
    };

    const resolver = vi.fn(async () => ({ includeThoughts: true, thinkingBudget: 123 }));

    const events = createAntigravityStream(resolver)(model, contextWith("Hi"), {
      apiKey: API_KEY,
      reasoning: "medium",
    });

    let final: AssistantMessage | undefined;

    for await (const event of events) {
      if (event.type === "done") final = event.message;

      if (event.type === "error") final = event.error;
    }

    expect(final?.stopReason).toBe("stop");
    expect(JSON.parse(requestBody)).toMatchObject({
      model: "new-model-medium",
      request: {
        generationConfig: {
          maxOutputTokens: 1234,
          thinkingConfig: { includeThoughts: true, thinkingBudget: 123 },
        },
      },
    });
    expect(resolver).toHaveBeenCalledOnce();
  });
});

describe("standalone thought signatures", () => {
  it("attaches a signature-only part to the preceding thinking block", async () => {
    const chunks = [
      JSON.stringify({
        response: { candidates: [{ content: { parts: [{ thought: true, text: "Reasoning" }] } }] },
      }),
      JSON.stringify({
        response: { candidates: [{ content: { parts: [{ thoughtSignature: "c2lnbmF0dXJl" }] } }] },
      }),
      textFrame("Answer"),
    ];

    const { final } = await collect(chunks);

    expect(final?.content[0]).toEqual({
      type: "thinking",
      thinking: "Reasoning",
      thinkingSignature: "c2lnbmF0dXJl",
    });
    expect(final?.content[1]).toMatchObject({ type: "text", text: "Answer" });
  });
});

describe("chunk decoding", () => {
  it("decodes text, thinking, usage, and finish reasons", () => {
    const chunk = decodeChunk(
      JSON.stringify({
        response: {
          modelVersion: "gemini-3.8-flash-high",
          responseId: "response-1",
          candidates: [
            {
              content: {
                parts: [
                  { text: "Planning", thought: true, thoughtSignature: "c2ln" },
                  { text: "Two loaves" },
                ],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 100,
            cachedContentTokenCount: 20,
            candidatesTokenCount: 30,
            thoughtsTokenCount: 10,
            totalTokenCount: 140,
          },
        },
      }),
    );

    expect(chunk?.modelVersion).toBe("gemini-3.8-flash-high");
    expect(chunk?.finishReason).toBe("STOP");
    expect(chunk?.parts).toEqual([
      { kind: "thinking", text: "Planning", signature: "c2ln" },
      { kind: "text", text: "Two loaves" },
    ]);
    expect(chunk?.usage).toEqual({
      input: 80,
      output: 40,
      reasoning: 10,
      cacheRead: 20,
      totalTokens: 140,
    });
  });

  it("decodes tool calls", () => {
    const chunk = decodeChunk(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ functionCall: { name: "bake_bread", args: { loaves: 2 }, id: "call-1" } }],
            },
            finishReason: "STOP",
          },
        ],
      }),
    );

    expect(chunk?.parts).toEqual([
      { kind: "toolCall", name: "bake_bread", args: { loaves: 2 }, id: "call-1" },
    ]);
  });

  it("decodes provider errors with their status", () => {
    const chunk = decodeChunk(JSON.stringify({ error: { code: 429, message: "Quota reached." } }));

    expect(chunk?.error).toEqual({ status: 429, message: "Quota reached." });
  });

  it("ignores malformed and non-chunk payloads", () => {
    expect(decodeChunk("not json")).toBeUndefined();
    expect(decodeChunk("[]")).toBeUndefined();
    expect(decodeChunk(JSON.stringify({ candidates: [] }))).toEqual({ parts: [] });
  });
});

describe("failure messages", () => {
  it("names the recovery action for each status", () => {
    expect(describeFailure(403, "")).toMatch(/Re-run \/login antigravity/);
    expect(describeFailure(404, "")).toMatch(/Select another model/);
    expect(describeFailure(429, "")).toMatch(/resource exhausted/);
    expect(describeFailure(500, "boom")).toBe("Antigravity request failed (500: boom).");
  });

  it("classifies exhaustion without echoing untrusted details", () => {
    expect(describeFailure(429, '{"error":{"message":"Quota exceeded"}}')).toMatch(
      /quota exceeded/,
    );
    expect(describeFailure(429, "account suspended")).toMatch(/account restriction/);
    expect(describeFailure(429, "rate limit reached")).toMatch(/rate limiting/);
    expect(describeFailure(429, "not json SECRET")).not.toContain("SECRET");
  });

  it.each([
    JSON.stringify({
      error: {
        code: 503,
        message: "No capacity available for model gemini-3.8-flash-medium on the server",
        status: "UNAVAILABLE",
        details: [{ reason: "MODEL_CAPACITY_EXHAUSTED" }],
      },
    }),
    "MODEL_CAPACITY_EXHAUSTED SECRET",
    "No capacity available for model gemini-3.8-flash-medium SECRET",
  ])("explains explicit 503 model capacity failures without echoing details", (body) => {
    expect(describeFailure(503, body)).toBe(
      "Antigravity has no capacity available for the selected model. Try another model or thinking level, or wait and retry.",
    );
  });

  it("does not infer model capacity from a generic 503 or an unbounded body", () => {
    expect(describeFailure(503, "Service unavailable")).toBe(
      "Antigravity request failed (503: Service unavailable).",
    );
    expect(describeFailure(503, "x".repeat(16_384) + "MODEL_CAPACITY_EXHAUSTED")).toMatch(
      /^Antigravity request failed/,
    );
    expect(describeFailure(500, "MODEL_CAPACITY_EXHAUSTED")).toMatch(/^Antigravity request failed/);
  });

  it("bounds the echoed provider body", () => {
    const message = describeFailure(500, "x".repeat(5000));

    expect(message.length).toBeLessThan(400);
  });
});

describe("stream implementation", () => {
  it("emits text deltas and a completed message", async () => {
    const { types, final } = await collect([textFrame("Two "), textFrame("loaves")]);

    expect(types[0]).toBe("start");
    expect(types).toContain("text_delta");
    expect(types.at(-1)).toBe("done");
    expect(final?.stopReason).toBe("stop");
    expect(final?.content).toEqual([{ type: "text", text: "Two loaves" }]);
  });

  it("records usage from the last frame", async () => {
    const { final } = await collect([
      textFrame("Done", {
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 4,
          thoughtsTokenCount: 1,
          totalTokenCount: 15,
        },
      }),
    ]);

    expect(final?.usage.input).toBe(10);
    expect(final?.usage.output).toBe(5);
    expect(final?.usage.reasoning).toBe(1);
    expect(final?.usage.totalTokens).toBe(15);
  });

  it("reports a tool call as the stop reason", async () => {
    const frame = JSON.stringify({
      candidates: [
        {
          content: { parts: [{ functionCall: { name: "bake_bread", args: { loaves: 2 } } }] },
          finishReason: "STOP",
        },
      ],
    });

    const { types, final } = await collect([frame]);

    expect(types).toContain("toolcall_end");
    expect(final?.stopReason).toBe("toolUse");
    expect(final?.content[0]).toMatchObject({ type: "toolCall", name: "bake_bread" });
  });

  it("sends the request envelope with credentials and tools", async () => {
    const seen: { url: string; body: string }[] = [];

    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the extension always sends a string body
      seen.push({ url, body: typeof init.body === "string" ? init.body : "" });

      return sse([textFrame("ok")]);
    });

    const stream = createAntigravityStream()(streamModel, contextWith("Bake bread"), {
      apiKey: API_KEY,
      sessionId: "envelope-session",
    });

    for await (const _event of stream) {
      // Drain the stream.
    }

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
    );

    const envelope = JSON.parse(seen[0]?.body ?? "{}");

    expect(envelope.project).toBe("project-under-test");
    expect(envelope.requestType).toBe("agent");
    expect(envelope.model).toBe("gemini-3.8-flash-medium");
    expect(envelope.request.systemInstruction.parts[0].text).toBe("You are terse.");
    expect(envelope.request.contents[0].parts[0].text).toBe("Bake bread");
  });

  it("falls back to the production endpoint when the daily endpoint is rate limited", async () => {
    const urls: string[] = [];

    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);

      if (url.includes("daily-cloudcode-pa")) {
        return new Response("rate limit exceeded", { status: 429 });
      }

      return sse([textFrame("served by production")]);
    });

    const stream = createAntigravityStream()(streamModel, contextWith("Bake bread"), {
      apiKey: API_KEY,
      sessionId: "fallback-session",
    });

    let final: AssistantMessage | undefined;

    for await (const event of stream) {
      if (event.type === "done") final = event.message;
    }

    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain("cloudcode-pa.googleapis.com");
    expect(final?.content).toEqual([{ type: "text", text: "served by production" }]);
  });

  it("stops on explicit model capacity exhaustion without triggering Pi retries", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 503,
              message: "No capacity available for model gemini-3.8-flash-medium on the server",
              details: [{ reason: "MODEL_CAPACITY_EXHAUSTED" }],
            },
          }),
          { status: 503 },
        ),
    );

    vi.stubGlobal("fetch", fetchMock);

    const stream = createAntigravityStream()(streamModel, contextWith("Bake bread"), {
      apiKey: API_KEY,
    });

    let final: AssistantMessage | undefined;

    for await (const event of stream) if (event.type === "error") final = event.error;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(final?.errorMessage).toMatch(/no capacity available/);
    expect(final && isRetryableAssistantError(final)).toBe(false);
  });

  it("stops on ambiguous exhaustion without triggering Pi retries", async () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        message: "Resource has been exhausted (e.g. check quota).",
        status: "RESOURCE_EXHAUSTED",
      },
    });

    const fetchMock = vi.fn(async () => new Response(body, { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    const stream = createAntigravityStream()(streamModel, contextWith("Bake bread"), {
      apiKey: API_KEY,
    });

    let final: AssistantMessage | undefined;

    for await (const event of stream) if (event.type === "error") final = event.error;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(final?.errorMessage).toMatch(/did not specify/);
    expect(final && isRetryableAssistantError(final)).toBe(false);

    const streamed = await collect([body]);
    expect(streamed.final?.errorMessage).toBe(final?.errorMessage);
    expect(streamed.final && isRetryableAssistantError(streamed.final)).toBe(false);
  });

  it("reports an aborted request without retrying", async () => {
    const controller = new AbortController();

    controller.abort();

    const stream = createAntigravityStream()(streamModel, contextWith("Bake bread"), {
      apiKey: API_KEY,
      signal: controller.signal,
      sessionId: "aborted-session",
    });

    const events = [];

    for await (const event of stream) events.push(event);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("error");
  });

  it("reports a missing credential as an error event", async () => {
    const stream = createAntigravityStream()(streamModel, contextWith("Bake bread"), {});
    const events = [];

    for await (const event of stream) events.push(event);

    expect(events.at(-1)?.type).toBe("error");
  });

  it("surfaces a provider error frame", async () => {
    const { types, final } = await collect([
      JSON.stringify({ error: { code: 403, message: "PERMISSION_DENIED" } }),
    ]);

    expect(types.at(-1)).toBe("error");
    expect(final?.errorMessage).toMatch(/denied access/);
  });

  it("fails a stream that ends without a finish reason", async () => {
    const frame = JSON.stringify({ candidates: [{ content: { parts: [{ text: "partial" }] } }] });
    const { types } = await collect([frame]);

    expect(types.at(-1)).toBe("error");
  });
});
