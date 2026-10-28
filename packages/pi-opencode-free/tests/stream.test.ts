import {
  isRetryableAssistantError,
  normalizeContext,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vite-plus/test";
import { isProviderRequestPayload } from "../src/request";
import {
  formatResetTime,
  quotaResetAt,
  isFreeUsageLimitMessage,
  usageLimitMessage,
} from "../src/quota";
import { createFreeStream } from "../src/stream";
import { BunTransportError } from "../src/bun-transport";

const model: Model<"openai-completions"> = {
  id: "test-free",
  name: "Test",
  provider: "opencode-free",
  api: "openai-completions",
  baseUrl: "https://provider.test/v1",
  input: ["text"],
  reasoning: false,
  contextWindow: 64000,
  maxTokens: 8000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens" },
};

const identity = () => ({ sessionId: "ses_ffffffffeffe0123456789ABCD", cliVersion: "2.1.4" });

const options = { apiKey: "public", maxRetries: 0 };

const summary = normalizeContext({
  systemPrompt: "Summarize without executing tools.",
  messages: [{ role: "user", content: "Summarize the conversation.", timestamp: 0 }],
});

function completion(): Response {
  return new Response(
    `data: ${JSON.stringify({
      id: "response-1",
      object: "chat.completion.chunk",
      created: 0,
      model: model.id,
      choices: [
        { index: 0, delta: { role: "assistant", content: "Summary." }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
    })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

function refusal(status: number, type: string, retryAfter?: string): Response {
  const headers = new Headers({ "content-type": "application/json" });

  if (retryAfter !== undefined) headers.set("retry-after", retryAfter);

  return new Response(
    JSON.stringify({ type: "error", error: { type, message: "Provider refused this request" } }),
    { status, headers },
  );
}

async function requestPayload(input: string | URL | Request, init?: RequestInit) {
  // SAFETY: the native OpenAI implementation serializes this request as JSON.
  return (await new Request(input, init).json()) as {
    stream: boolean;
    messages: Array<{ role: string; content: string }>;
    tools: Array<{ function: { name: string } }>;
    tool_choice?: string;
    temperature?: number;
    metadata?: { preserved: boolean };
  };
}

describe("OpenCode provider stream boundary", () => {
  it("preserves Bun installation guidance through native SDK connection errors", async () => {
    const message =
      "OpenCode Free could not start its Bun transport. Install Bun or set PI_OPENCODE_FREE_BUN.";

    const native = createFreeStream(async () => {
      throw new BunTransportError(message);
    }, identity);

    expect((await native(model, summary, options).result()).errorMessage).toBe(message);
  });
  it("normalizes a tool-free compaction request without relying on turn hooks", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const payload = await requestPayload(input, init);
      expect(payload.stream).toBe(true);
      expect(payload.tools.map((tool) => tool.function.name)).toEqual(["read"]);
      expect(JSON.stringify(payload.messages)).toContain("Summarize without executing tools.");
      expect(JSON.stringify(payload.messages)).toContain("<env>");
      expect(payload).not.toHaveProperty("tool_choice");
      expect(new Headers(init?.headers).get("x-opencode-session")).toBe(identity().sessionId);

      return completion();
    });

    const stream = createFreeStream(fetcher, identity)(model, summary, options);
    const events = [];

    for await (const event of stream) events.push(event);
    const result = await stream.result();
    expect(result.stopReason).toBe("stop");
    expect(result.content).toMatchObject([{ type: "text", text: "Summary." }]);
    expect(result.usage).toMatchObject({ input: 12, output: 3, totalTokens: 15 });
    expect(events[0]?.type).toBe("start");
    expect(events.at(-1)?.type).toBe("done");
    expect(events.filter((event) => event.type === "done" || event.type === "error")).toHaveLength(
      1,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("honors the caller's replacement payload, tools, instrumentation, and fetch implementation", async () => {
    const onPayload = vi.fn<NonNullable<SimpleStreamOptions["onPayload"]>>(async (payload) => {
      if (!isProviderRequestPayload(payload)) throw new Error("invalid native payload");

      return {
        ...payload,
        stream: false,
        tool_choice: "none",
        temperature: 0.2,
        metadata: { preserved: true },
      };
    });

    const onResponse = vi.fn();
    const onProviderStreamEvent = vi.fn();

    const overrideFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const payload = await requestPayload(input, init);
      expect(payload).toMatchObject({
        stream: true,
        temperature: 0.2,
        metadata: { preserved: true },
      });
      expect(payload).not.toHaveProperty("tool_choice");
      expect(payload.tools.map((tool) => tool.function.name)).toEqual(["bash"]);
      const headers = new Headers(init?.headers);
      expect(headers.get("x-custom")).toBe("preserved");
      expect(headers.has("x-opencode-request")).toBe(false);

      return completion();
    });

    const context = normalizeContext({
      messages: [{ role: "user", content: "Hi", timestamp: 0 }],
      tools: [
        {
          name: "bash",
          description: "Run a command",
          parameters: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
      ],
    });

    const native = createFreeStream(async () => {
      throw new Error("must use caller fetch");
    }, identity);

    const result = await native(model, context, {
      ...options,
      fetch: overrideFetch,
      onPayload,
      onResponse,
      onProviderStreamEvent,
      headers: { "x-custom": "preserved", "x-opencode-request": "obsolete" },
    }).result();

    expect(result.stopReason).toBe("stop");
    expect(onPayload).toHaveBeenCalledTimes(1);
    expect(onResponse).toHaveBeenCalledWith(
      expect.objectContaining({ status: 200 }),
      expect.objectContaining({ id: model.id }),
    );
    expect(onProviderStreamEvent).toHaveBeenCalledTimes(1);
  });

  it.each(["3600", "Fri, 23 Oct 2026 13:00:00 GMT", undefined, "invalid"])(
    "reports a usage limit with Retry-After %s",
    async (retryAfter) => {
      const now = Date.parse("2026-10-23T12:00:00Z");
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);

      try {
        const fetcher = vi.fn(async () => refusal(429, "FreeUsageLimitError", retryAfter));
        const native = createFreeStream(fetcher, identity);

        const result = await native(model, summary, options).result();
        expect(result.stopReason).toBe("error");

        const reset =
          retryAfter === "3600" || retryAfter?.startsWith("Fri")
            ? `Reset time: ${formatResetTime(Date.parse("2026-10-23T13:00:00Z"))}.`
            : "Reset time unavailable.";

        expect(result.errorMessage).toBe(`OpenCode Free quota exceeded.\n${reset}`);
        expect(isRetryableAssistantError(result)).toBe(false);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(result.errorMessage).not.toMatch(/Retry-After|https:\/\//u);
      } finally {
        clock.mockRestore();
      }
    },
  );

  it.each([
    [403, "FreeTierError"],
    [429, "RateLimitError"],
    [500, "FreeUsageLimitError"],
  ])("preserves unrelated failures: %s %s", async (status, type) => {
    const native = createFreeStream(async () => refusal(status, type, "3600"), identity);

    const result = await native(model, summary, options).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain(type);
    expect(result.errorMessage).not.toContain("Reset time:");
  });

  it("keeps ordinary rate limits retryable", async () => {
    const native = createFreeStream(async () => refusal(429, "RateLimitError", "3600"), identity);

    const result = await native(model, summary, options).result();
    expect(result.stopReason).toBe("error");
    expect(isRetryableAssistantError(result)).toBe(true);
    expect(result.errorMessage).toContain("RateLimitError");
    expect(result.errorMessage).not.toContain("Reset time:");
  });

  it("keeps quota timing scoped to each concurrent request", async () => {
    let calls = 0;

    const native = createFreeStream(async () => {
      calls += 1;

      return calls === 1
        ? refusal(429, "FreeUsageLimitError", "3600")
        : refusal(429, "FreeUsageLimitError");
    }, identity);

    const [first, second] = await Promise.all([
      native(model, summary, options).result(),
      native(model, summary, options).result(),
    ]);

    expect(first.errorMessage).toContain("Reset time:");
    expect(second.errorMessage).toContain("Reset time unavailable.");
  });

  it("forwards native tool calls unchanged", async () => {
    const native = createFreeStream(
      async () =>
        new Response(
          `data: ${JSON.stringify({
            id: "tool-response",
            object: "chat.completion.chunk",
            created: 0,
            model: model.id,
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call-1",
                      type: "function",
                      function: { name: "read", arguments: '{"path":"README.md"}' },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
      identity,
    );

    const result = await native(model, summary, options).result();
    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toMatchObject([
      { type: "toolCall", name: "read", arguments: { path: "README.md" } },
    ]);
  });

  it("preserves caller cancellation", async () => {
    const controller = new AbortController();
    controller.abort();

    const native = createFreeStream(async () => {
      throw new DOMException("Aborted", "AbortError");
    }, identity);

    const result = await native(model, summary, { ...options, signal: controller.signal }).result();
    expect(result.stopReason).toBe("aborted");
  });

  it("closes the stream before inference if asynchronous version resolution fails", async () => {
    const fetcher = vi.fn(async () => completion());

    const native = createFreeStream(fetcher, async () => {
      throw new Error("version lookup failed");
    });

    const stream = native(model, summary, options);
    expect(await stream.result()).toMatchObject({
      stopReason: "error",
      errorMessage: "version lookup failed",
    });
    expect(fetcher).not.toHaveBeenCalled();
    const events = [];

    for await (const event of stream) events.push(event);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("error");
  });

  it("preserves cancellation during asynchronous version resolution", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async () => completion());

    const native = createFreeStream(fetcher, async (signal) => {
      expect(signal).toBe(controller.signal);
      controller.abort();

      return identity();
    });

    const result = await native(model, summary, { ...options, signal: controller.signal }).result();
    expect(result.stopReason).toBe("aborted");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("closes the forwarding stream if request setup fails", async () => {
    const fetcher = vi.fn(async () => completion());
    const native = createFreeStream(fetcher, identity);

    const settings: SimpleStreamOptions = {
      ...options,
      get maxRetries(): number {
        throw new Error("invalid retry settings");
      },
    };

    const stream = native(model, summary, settings);
    expect(await stream.result()).toMatchObject({
      stopReason: "error",
      errorMessage: "invalid retry settings",
    });
    expect(fetcher).not.toHaveBeenCalled();
    const events = [];

    for await (const event of stream) events.push(event);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("error");
  });

  it("does not turn malformed replacement payloads into valid requests", async () => {
    const settings: SimpleStreamOptions = {
      ...options,
      onPayload: async () => ({ model: "test-free", tools: "invalid" }),
    };

    const native = createFreeStream(async (input, init) => {
      expect(await requestPayload(input, init)).toMatchObject({ tools: "invalid" });

      return refusal(400, "BadRequestError");
    }, identity);

    expect((await native(model, summary, settings).result()).stopReason).toBe("error");
  });
});

describe("quota reset formatting", () => {
  const resetAt = Date.parse("2026-10-24T00:00:00Z");

  it("uses the Pi process's locale and timezone by default", () => {
    expect(formatResetTime(resetAt)).toBe(
      new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        hourCycle: "h23",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(resetAt),
    );
    expect(formatResetTime(resetAt + 37_000)).toBe(formatResetTime(resetAt));
  });

  it.each([
    ["de_DE.UTF-8", "de-DE", "Europe/Berlin", "02:00"],
    ["en_US.UTF-8", "en-US", "America/New_York", "20:00"],
    ["en_US.UTF-8", "en-US", "UTC", "00:00"],
  ])(
    "inherits %s (%s) and timezone %s from a fresh Pi host process",
    (language, locale, timeZone, clock) => {
      const source = new URL("../src/quota.ts", import.meta.url).href;

      const code = `
      import { formatResetTime } from ${JSON.stringify(source)};
      const formatter = new Intl.DateTimeFormat(undefined, {
        year: "numeric", month: "short", day: "numeric",
        hour: "2-digit", hourCycle: "h23", minute: "2-digit", timeZoneName: "short",
      });
      console.log(formatResetTime(${resetAt}));
      console.log(formatter.format(${resetAt}));
      console.log(formatter.resolvedOptions().locale);
      console.log(formatter.resolvedOptions().timeZone);
    `;

      const lines = execFileSync(process.execPath, ["--input-type=module", "-e", code], {
        encoding: "utf8",
        env: { ...process.env, LANG: language, LC_ALL: language, TZ: timeZone },
      })
        .trim()
        .split("\n");

      expect(lines[0]).toBe(lines[1]);
      expect(lines[0]).toContain(clock);
      expect(lines[0]).not.toMatch(/AM|PM|\d{2}:\d{2}:\d{2}/u);
      expect(lines[2]).toBe(locale);
      expect(lines[3]).toBe(timeZone);
    },
  );

  it("uses locale-specific formatting and daylight-saving rules", () => {
    const german = new Intl.DateTimeFormat("de-DE", {
      dateStyle: "medium",
      timeStyle: "long",
      timeZone: "Europe/Berlin",
    });

    expect(formatResetTime(resetAt, german)).toBe(german.format(resetAt));

    const newYork = new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "long",
      timeZone: "America/New_York",
    });

    expect(formatResetTime(Date.parse("2026-03-08T07:00:00Z"), newYork)).toContain(
      "3:00:00 AM EDT",
    );
  });
});

describe("native quota error recognition", () => {
  it.each([
    '429 {"type":"FreeUsageLimitError","message":"Quota reached"}',
    '429: {"error":{"type":"FreeUsageLimitError"}}',
  ])("recognizes the actual error tag: %s", (message) => {
    expect(isFreeUsageLimitMessage(message)).toBe(true);
  });
  it.each([
    undefined,
    "",
    "429 FreeUsageLimitError",
    '429 {"type":',
    '429 {"type":"OtherError","message":"FreeUsageLimitError"}',
    '429 {"type":"OtherError","details":{"type":"FreeUsageLimitError"}}',
    '429 {"error":null}',
    '429 {"error":"FreeUsageLimitError"}',
    `429 ${"x".repeat(16_385)}`,
  ])("leaves unrelated, malformed, or oversized errors unchanged", (message) => {
    expect(isFreeUsageLimitMessage(message)).toBe(false);
  });
});

describe("quota timing", () => {
  const now = Date.parse("2026-10-23T12:00:00Z");
  it.each([
    "-1",
    "Infinity",
    "NaN",
    "1e20",
    "999999999999999999",
    "Thu, 22 Oct 2026 12:00:00 GMT",
    "",
    "garbage",
  ])("rejects invalid or past Retry-After %s", (value) => {
    expect(quotaResetAt(new Headers({ "retry-after": value }), now)).toBeUndefined();
  });
  it("preserves a zero or fractional retry delay", () => {
    expect(quotaResetAt(new Headers({ "retry-after": "0" }), now)).toBe(now);
    expect(quotaResetAt(new Headers({ "retry-after": "0.5" }), now)).toBe(now + 500);
    expect(usageLimitMessage(new Headers(), now)).toBe(
      "OpenCode Free quota exceeded.\nReset time unavailable.",
    );
  });
});
