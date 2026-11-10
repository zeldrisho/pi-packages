import type { Api, Context, Model, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";

import {
  createChunkedCompactionHandler,
  registerChunkedCompaction,
  type CompactionContext,
  type CompactionEvent,
  type CompactionModel,
  type CompactionPreparation,
  type CompactionResponse,
} from "../src/compaction";

const PROVIDER_ID = "opencode-free";

type RegisteredHandler = (
  event: CompactionEvent,
  context: ExtensionContext,
) => Promise<SessionBeforeCompactResult | undefined>;

interface Call {
  systemPrompt: string;
  prompt: string;
  /** The extension leaves the answer cap to Pi, so no request carries one. */
  carriesCap: boolean;
  reasoning: boolean;
}

interface Harness {
  calls: Call[];
  notifications: string[];
  statuses: (string | undefined)[];
  handler: ReturnType<typeof createChunkedCompactionHandler>;
  context: CompactionContext;
  event: CompactionEvent;
}

type Responder = (call: Call, index: number) => CompactionResponse | Error;

const USAGE: Usage = {
  input: 100,
  output: 50,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 150,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const CHECKPOINT = [
  "## Goal",
  "Ship the patch",
  "",
  "## Progress",
  "### Done",
  "- work",
  "",
  "## Next Steps",
  "1. continue",
  "",
  "## Critical Context",
  "- src/file.ts",
].join("\n");

function isCheckpointRequest(call: Call): boolean {
  return call.prompt.includes("Use this EXACT format:");
}

function messages(count: number, chars: number): CompactionPreparation["messagesToSummarize"] {
  return Array.from({ length: count }, (_value, index) => ({
    role: "user",
    content: [{ type: "text", text: `message ${index}: ${"x".repeat(chars)}` }],
    timestamp: index,
  }));
}

function response(text: string, stopReason: CompactionResponse["stopReason"]): CompactionResponse {
  return { text, usage: USAGE, stopReason, hasToolCalls: false };
}

function createHarness(options: {
  messageList?: CompactionPreparation["messagesToSummarize"];
  contextWindow?: number;
  maxTokens?: number;
  provider?: string;
  respond?: Responder;
  branchEntries?: CompactionEvent["branchEntries"];
  signal?: AbortSignal;
  reserveTokens?: number;
  previousSummary?: string;
  turnPrefixList?: CompactionPreparation["turnPrefixMessages"];
}): Harness {
  const calls: Call[] = [];
  const notifications: string[] = [];
  const statuses: (string | undefined)[] = [];

  const model: CompactionModel = {
    provider: options.provider ?? PROVIDER_ID,
    contextWindow: options.contextWindow ?? 200_000,
    maxTokens: options.maxTokens ?? 32_000,
  };

  const respond: Responder =
    options.respond ??
    ((call, index) =>
      response(isCheckpointRequest(call) ? CHECKPOINT : `DIGEST-${index + 1}`, "stop"));

  const context: CompactionContext = {
    model,
    async complete(request) {
      const call: Call = {
        systemPrompt: request.systemPrompt,
        prompt: request.prompt,
        carriesCap: "maxTokens" in request,
        reasoning: "reasoning" in request,
      };

      calls.push(call);

      const outcome = respond(call, calls.length - 1);

      if (outcome instanceof Error) throw outcome;

      return outcome;
    },
    notify: (message) => void notifications.push(message),
    setStatus: (text) => void statuses.push(text),
  };

  const event: CompactionEvent = {
    preparation: {
      firstKeptEntryId: "entry-kept",
      messagesToSummarize: options.messageList ?? messages(60, 2_000),
      turnPrefixMessages: options.turnPrefixList ?? [],
      settings: { reserveTokens: options.reserveTokens ?? 16_384 },
      tokensBefore: 300_000,
      previousSummary: options.previousSummary,
      fileOps: {
        read: new Set(["src/read-only.ts", "src/edited.ts"]),
        written: new Set(["src/written.ts"]),
        edited: new Set(["src/edited.ts"]),
      },
    },
    branchEntries: options.branchEntries ?? [],
    reason: "overflow",
    signal: options.signal ?? new AbortController().signal,
  };

  return {
    calls,
    notifications,
    statuses,
    handler: createChunkedCompactionHandler(PROVIDER_ID),
    context,
    event,
  };
}

describe("segmented compaction", () => {
  it("defers to Pi's compaction when one request has output room", async () => {
    const harness = createHarness({ messageList: messages(20, 400), contextWindow: 200_000 });

    await expect(harness.handler(harness.event, harness.context)).resolves.toBeUndefined();
    expect(harness.calls).toHaveLength(0);
  });

  it("leaves other providers to Pi's compaction", async () => {
    const harness = createHarness({ provider: "anthropic", contextWindow: 40_000 });

    await expect(harness.handler(harness.event, harness.context)).resolves.toBeUndefined();
    expect(harness.calls).toHaveLength(0);
  });

  it("summarizes a history that a single request cannot cover", async () => {
    const harness = createHarness({ contextWindow: 40_000 });

    const result = await harness.handler(harness.event, harness.context);

    expect(result?.compaction?.firstKeptEntryId).toBe("entry-kept");
    expect(result?.compaction?.tokensBefore).toBe(300_000);
    expect(result?.compaction?.summary).toContain("## Goal");
    expect(harness.calls.at(-1)?.prompt).toContain("DIGEST-");
    expect(harness.calls.length).toBeGreaterThanOrEqual(3);
    expect(harness.notifications.join(" ")).toContain("Compacted 60 messages");
    expect(harness.statuses.at(-1)).toBeUndefined();
  });

  it("leaves the answer cap to Pi so the window clamp decides", async () => {
    const harness = createHarness({ contextWindow: 40_000 });

    await harness.handler(harness.event, harness.context);

    expect(harness.calls.length).toBeGreaterThan(0);

    for (const call of harness.calls) {
      expect(call.carriesCap).toBe(false);
      // The advertised output limit must still fit beside the prompt, so Pi's clamp
      // only trims it instead of cutting the answer to nothing.
      expect(Math.ceil(call.prompt.length / 4) + 32_000).toBeLessThanOrEqual(40_000);
    }
  });

  it("never requests a thinking level", async () => {
    const harness = createHarness({ contextWindow: 40_000 });

    await harness.handler(harness.event, harness.context);

    expect(harness.calls.length).toBeGreaterThan(0);

    for (const call of harness.calls) expect(call.reasoning).toBe(false);
  });

  it("accumulates usage across requests", async () => {
    const harness = createHarness({ contextWindow: 40_000 });

    const result = await harness.handler(harness.event, harness.context);

    expect(result?.compaction?.usage?.totalTokens).toBe(USAGE.totalTokens * harness.calls.length);
    expect(result?.compaction?.usage?.cost.total).toBe(0);
  });

  it("splits a segment whose digest hits the token cap instead of keeping the partial text", async () => {
    let truncated = false;

    const harness = createHarness({
      contextWindow: 40_000,
      respond: (_call, index) => {
        if (index === 0 && !truncated) {
          truncated = true;

          return response("PARTIAL", "length");
        }

        return response(isCheckpointRequest(_call) ? CHECKPOINT : `DIGEST-${index + 1}`, "stop");
      },
    });

    const result = await harness.handler(harness.event, harness.context);
    const finalPrompt = harness.calls.at(-1)?.prompt ?? "";

    expect(finalPrompt).not.toContain("PARTIAL");
    expect(finalPrompt).toContain("DIGEST-");
    expect(result?.compaction?.summary).toContain("## Goal");
    expect(harness.calls.length).toBeGreaterThanOrEqual(5);
  });

  it("falls back to Pi's compaction when the provider fails", async () => {
    const harness = createHarness({
      contextWindow: 40_000,
      respond: () => new Error("gateway unavailable"),
    });

    await expect(harness.handler(harness.event, harness.context)).resolves.toBeUndefined();
    expect(harness.notifications.join(" ")).toContain("Using Pi's compaction");
  });

  it("cancels when the caller aborts", async () => {
    const controller = new AbortController();
    controller.abort();

    const harness = createHarness({
      contextWindow: 40_000,
      signal: controller.signal,
      respond: () => new Error("aborted"),
    });

    await expect(harness.handler(harness.event, harness.context)).resolves.toEqual({
      cancel: true,
    });
  });

  it("records written and edited files as modified and carries earlier lists", async () => {
    const harness = createHarness({
      contextWindow: 40_000,
      branchEntries: [
        { type: "compaction", details: { readFiles: ["old.ts"], modifiedFiles: ["old-mod.ts"] } },
      ],
    });

    const result = await harness.handler(harness.event, harness.context);
    const summary = result?.compaction?.summary ?? "";

    const readBlock = summary.slice(
      summary.indexOf("<read-files>"),
      summary.indexOf("</read-files>"),
    );

    const modifiedBlock = summary.slice(
      summary.indexOf("<modified-files>"),
      summary.indexOf("</modified-files>"),
    );

    expect(readBlock).toContain("src/read-only.ts");
    expect(readBlock).toContain("old.ts");
    expect(readBlock).not.toContain("src/edited.ts");
    expect(modifiedBlock).toContain("src/edited.ts");
    expect(modifiedBlock).toContain("src/written.ts");
    expect(modifiedBlock).toContain("old-mod.ts");
  });

  it("ignores malformed file lists on earlier compaction entries", async () => {
    const harness = createHarness({
      contextWindow: 40_000,
      branchEntries: [{ type: "compaction", details: { readFiles: [1, 2] } }],
    });

    const result = await harness.handler(harness.event, harness.context);

    expect(result?.compaction?.details).toEqual({
      readFiles: ["src/read-only.ts"],
      modifiedFiles: ["src/edited.ts", "src/written.ts"],
    });
  });

  it("keeps a partial digest when a single message cannot be split", async () => {
    const harness = createHarness({
      contextWindow: 6_000,
      messageList: messages(1, 2_000),
      respond: (call) =>
        isCheckpointRequest(call)
          ? response(CHECKPOINT, "stop")
          : response("PARTIAL-ONLY", "length"),
    });

    const result = await harness.handler(harness.event, harness.context);

    expect(result?.compaction?.summary).toContain("## Goal");
    expect(harness.calls.at(-1)?.prompt).toContain("PARTIAL-ONLY");
  });

  it("omits file sections when nothing was read or modified", async () => {
    const harness = createHarness({ contextWindow: 40_000 });
    harness.event.preparation.fileOps = { read: new Set(), written: new Set(), edited: new Set() };

    const result = await harness.handler(harness.event, harness.context);

    expect(result?.compaction?.summary).not.toContain("<read-files>");
    expect(result?.compaction?.summary).not.toContain("<modified-files>");
    expect(result?.compaction?.details).toEqual({ readFiles: [], modifiedFiles: [] });
  });

  it("ignores details that are not file lists", async () => {
    const harness = createHarness({
      contextWindow: 40_000,
      branchEntries: [
        { type: "message" },
        { type: "compaction", details: "not-an-object" },
        { type: "compaction", details: { readFiles: ["kept.ts"] } },
      ],
    });

    const result = await harness.handler(harness.event, harness.context);

    expect(result?.compaction?.details).toEqual({
      readFiles: ["kept.ts", "src/read-only.ts"],
      modifiedFiles: ["src/edited.ts", "src/written.ts"],
    });
  });

  it("accumulates reasoning tokens reported by the provider", async () => {
    const harness = createHarness({
      contextWindow: 40_000,
      respond: (call, index) => ({
        text: isCheckpointRequest(call) ? CHECKPOINT : `DIGEST-${index + 1}`,
        usage: { ...USAGE, reasoning: 7 },
        stopReason: "stop",
      }),
    });

    const result = await harness.handler(harness.event, harness.context);

    expect(result?.compaction?.usage?.reasoning).toBe(7 * harness.calls.length);
  });

  it("merges digests before the final checkpoint", async () => {
    const harness = createHarness({
      contextWindow: 90_000,
      messageList: messages(160, 2_000),
      respond: (call) => {
        if (isCheckpointRequest(call)) return response(CHECKPOINT, "stop");

        if (call.prompt.startsWith("<digests>")) return response("MERGED-DIGEST", "stop");

        return response("d".repeat(20_000), "stop");
      },
    });

    const result = await harness.handler(harness.event, harness.context);

    expect(harness.calls.some((call) => call.prompt.startsWith("<digests>"))).toBe(true);
    expect(result?.compaction?.summary).toContain("## Goal");
  });

  it("falls back when a checkpoint that cannot be reduced stops at the cap", async () => {
    const harness = createHarness({
      contextWindow: 6_000,
      messageList: messages(1, 2_000),
      respond: (call) =>
        isCheckpointRequest(call) ? response("PARTIAL", "length") : response("DIGEST", "stop"),
    });

    await expect(harness.handler(harness.event, harness.context)).resolves.toBeUndefined();
    expect(harness.notifications.join(" ")).toContain("Pi's compaction");
  });

  it("reminds the model when the checkpoint skips the template", async () => {
    let checkpointCalls = 0;

    const harness = createHarness({
      contextWindow: 40_000,
      respond: (call) => {
        if (!isCheckpointRequest(call)) return response("DIGEST", "stop");

        checkpointCalls += 1;

        return checkpointCalls === 1
          ? response("no template here", "stop")
          : response(CHECKPOINT, "stop");
      },
    });

    const result = await harness.handler(harness.event, harness.context);

    expect(checkpointCalls).toBe(2);
    expect(harness.calls.at(-1)?.prompt).toContain(
      "did not fill in the required checkpoint template",
    );
    expect(result?.compaction?.summary).toContain("## Goal");
  });

  it("falls back when the checkpoint never follows the template", async () => {
    const harness = createHarness({
      contextWindow: 40_000,
      respond: (call) =>
        isCheckpointRequest(call)
          ? response("no template here", "stop")
          : response("DIGEST", "stop"),
    });

    await expect(harness.handler(harness.event, harness.context)).resolves.toBeUndefined();
    expect(harness.notifications.join(" ")).toContain("Pi's compaction");
  });

  it("splices a split turn prefix into the checkpoint with Pi's marker", async () => {
    const harness = createHarness({
      contextWindow: 40_000,
      turnPrefixList: messages(2, 500),
    });

    const result = await harness.handler(harness.event, harness.context);
    const summary = result?.compaction?.summary ?? "";

    expect(summary).toContain("## Goal");
    expect(summary).toContain("**Turn Context (split turn):**");
    expect(harness.calls.at(-1)?.prompt).toContain("earlier context from an ongoing conversation");
  });

  it("keeps the previous checkpoint when only a turn prefix remains", async () => {
    const harness = createHarness({
      contextWindow: 40_000,
      messageList: [],
      turnPrefixList: messages(2, 500),
      previousSummary: "EARLIER CHECKPOINT",
      reserveTokens: 40_000,
    });

    const result = await harness.handler(harness.event, harness.context);
    const summary = result?.compaction?.summary ?? "";

    expect(summary.startsWith("EARLIER CHECKPOINT")).toBe(true);
    expect(summary).toContain("**Turn Context (split turn):**");
    expect(harness.calls).toHaveLength(1);
  });

  it("falls back when a summary tries to call a tool", async () => {
    const harness = createHarness({
      contextWindow: 40_000,
      respond: (call) => ({
        ...response(isCheckpointRequest(call) ? CHECKPOINT : "DIGEST", "stop"),
        hasToolCalls: true,
      }),
    });

    await expect(harness.handler(harness.event, harness.context)).resolves.toBeUndefined();
    expect(harness.notifications.join(" ")).toContain("attempted to call a tool");
  });

  it("still compacts when the model advertises a small output limit", async () => {
    const harness = createHarness({ contextWindow: 40_000, maxTokens: 3_000 });

    const result = await harness.handler(harness.event, harness.context);

    expect(result?.compaction?.summary).toContain("## Goal");
    expect(harness.calls.every((call) => !call.carriesCap)).toBe(true);
  });

  it("scales the segment budget with the model window", async () => {
    const segmentCount = async (contextWindow: number): Promise<number> => {
      const harness = createHarness({ contextWindow, messageList: messages(120, 2_000) });

      await harness.handler(harness.event, harness.context);

      return Number(/(\d+) segment/.exec(harness.statuses[0] ?? "")?.[1] ?? 0);
    };

    const narrow = await segmentCount(70_000);
    const wide = await segmentCount(78_000);

    expect(narrow).toBeGreaterThan(wide);
    expect(wide).toBeGreaterThan(0);
  });

  it("uses Pi's checkpoint prompt and update instructions", async () => {
    const harness = createHarness({ contextWindow: 40_000, previousSummary: "EARLIER CHECKPOINT" });

    const result = await harness.handler(harness.event, harness.context);
    const final = harness.calls.at(-1);

    expect(final?.systemPrompt).toContain("You are a context summarization assistant");
    expect(final?.prompt).toContain("<previous-summary>");
    expect(final?.prompt).toContain("PRESERVE all existing information");
    expect(result?.compaction?.summary).toContain("## Goal");
  });

  it("registers the handler on the extension API", () => {
    const registered: string[] = [];

    const proxy = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === "on") {
            return (name: string): (() => void) => {
              registered.push(name);

              return () => {};
            };
          }

          return undefined;
        },
      },
    );

    // SAFETY: the proxy supplies the ExtensionAPI member this registration reads.
    registerChunkedCompaction(proxy as ExtensionAPI, PROVIDER_ID);

    expect(registered).toEqual(["session_before_compact"]);
  });

  it("adapts Pi's extension context without a thinking level or model switch", async () => {
    const requests: SimpleStreamOptions[] = [];
    const notifications: string[] = [];
    const statuses: (string | undefined)[] = [];

    const model: Model<Api> = {
      id: "free-model",
      name: "Free model",
      provider: PROVIDER_ID,
      api: "openai-completions",
      contextWindow: 40_000,
      maxTokens: 32_000,
      input: ["text"],
      reasoning: false,
      baseUrl: "https://example.invalid",
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };

    const context = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === "model") return model;

          if (property === "modelRegistry") {
            return {
              streamSimple(_model: Model<Api>, _request: Context, options: SimpleStreamOptions) {
                requests.push(options);

                return {
                  result: async () => ({
                    stopReason: "stop",
                    content: [
                      { type: "thinking", thinking: "hidden" },
                      { type: "text", text: CHECKPOINT },
                    ],
                    usage: USAGE,
                  }),
                };
              },
            };
          }

          if (property === "ui") {
            return {
              notify: (message: string, type: string): void =>
                void notifications.push(`${type}: ${message}`),
              setStatus: (_key: string, text: string | undefined): void => void statuses.push(text),
            };
          }

          return undefined;
        },
      },
    );

    let registered: RegisteredHandler | undefined;

    const pi = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === "on") {
            return (name: string, handler: RegisteredHandler): (() => void) => {
              if (name === "session_before_compact") registered = handler;

              return () => {};
            };
          }

          return undefined;
        },
      },
    );

    // SAFETY: the proxy supplies the ExtensionAPI member registration reads.
    registerChunkedCompaction(pi as ExtensionAPI, PROVIDER_ID, {
      createSessionId: () => "routing-id",
    });

    const harness = createHarness({ contextWindow: 40_000 });
    // SAFETY: the proxy supplies the ExtensionContext members the adapter reads.
    const result = await registered?.(harness.event, context as ExtensionContext);

    expect(result?.compaction).toBeDefined();
    expect(requests.length).toBeGreaterThan(0);

    for (const request of requests) {
      expect(Object.hasOwn(request, "reasoning")).toBe(false);
      expect(request.cacheRetention).toBe("none");
      expect(request.sessionId).toBe("routing-id");
    }

    expect(notifications.join(" ")).toContain("Compacted");
    expect(statuses.at(-1)).toBeUndefined();
  });

  it("defers when Pi has no model selected", async () => {
    let requests = 0;

    const context = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === "model") return undefined;

          if (property === "modelRegistry") {
            return {
              streamSimple(): void {
                requests += 1;
              },
            };
          }

          return undefined;
        },
      },
    );

    let registered: RegisteredHandler | undefined;

    const pi = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === "on") {
            return (name: string, handler: RegisteredHandler): (() => void) => {
              if (name === "session_before_compact") registered = handler;

              return () => {};
            };
          }

          return undefined;
        },
      },
    );

    // SAFETY: the proxy supplies the ExtensionAPI member registration reads.
    registerChunkedCompaction(pi as ExtensionAPI, PROVIDER_ID);

    const harness = createHarness({ contextWindow: 40_000 });
    // SAFETY: the proxy supplies the ExtensionContext members the adapter reads.
    const result = await registered?.(harness.event, context as ExtensionContext);

    expect(result).toBeUndefined();
    expect(requests).toBe(0);
  });
});
