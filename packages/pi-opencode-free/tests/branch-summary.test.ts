import type { Api, Context, Model, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeTreeResult,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";

import {
  createBranchSummaryHandler,
  registerBranchSummary,
  type BranchEvent,
  type CompactionContext,
  type CompactionModel,
  type CompactionResponse,
} from "../src/compaction";

const PROVIDER_ID = "opencode-free";

type RegisteredHandler = (
  event: BranchEvent,
  context: ExtensionContext,
) => Promise<SessionBeforeTreeResult | undefined>;

interface Call {
  systemPrompt: string;
  prompt: string;
  /** The extension leaves the answer cap to Pi, so no request carries one. */
  carriesCap: boolean;
  reasoning: boolean;
}

type Responder = (call: Call, index: number) => CompactionResponse | Error;

interface Harness {
  calls: Call[];
  notifications: string[];
  statuses: (string | undefined)[];
  handler: ReturnType<typeof createBranchSummaryHandler>;
  context: CompactionContext;
  event: BranchEvent;
}

const USAGE: Usage = {
  input: 100,
  output: 50,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 150,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const BRANCH_SUMMARY = [
  "## Goal",
  "Ship the patch",
  "",
  "## Constraints & Preferences",
  "- none",
  "",
  "## Progress",
  "### Done",
  "- work",
  "",
  "## Next Steps",
  "1. continue",
].join("\n");

/** Builds one user message entry, which is all `prepareBranchEntries` needs here. */
function entry(index: number, chars: number): SessionEntry {
  return {
    type: "message",
    id: `entry-${index}`,
    parentId: index === 0 ? null : `entry-${index - 1}`,
    timestamp: new Date(index * 1_000).toISOString(),
    message: {
      role: "user",
      content: [{ type: "text", text: `message ${index}: ${"x".repeat(chars)}` }],
      timestamp: index * 1_000,
    },
  };
}

function entries(count: number, chars: number): SessionEntry[] {
  return Array.from({ length: count }, (_value, index) => entry(index, chars));
}

function response(text: string, stopReason: CompactionResponse["stopReason"]): CompactionResponse {
  return { text, usage: USAGE, stopReason, hasToolCalls: false };
}

function isSummaryRequest(call: Call): boolean {
  return call.prompt.includes("<digests>") && !call.prompt.includes("Merge these digests");
}

function createHarness(options: {
  entryList?: SessionEntry[];
  contextWindow?: number;
  maxTokens?: number;
  provider?: string;
  respond?: Responder;
  userWantsSummary?: boolean;
  customInstructions?: string;
  replaceInstructions?: boolean;
  signal?: AbortSignal;
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
      response(isSummaryRequest(call) ? BRANCH_SUMMARY : `DIGEST-${index + 1}`, "stop"));

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

  const event: BranchEvent = {
    preparation: {
      entriesToSummarize: options.entryList ?? entries(60, 2_000),
      userWantsSummary: options.userWantsSummary ?? true,
      customInstructions: options.customInstructions,
      replaceInstructions: options.replaceInstructions,
    },
    signal: options.signal ?? new AbortController().signal,
  };

  return {
    calls,
    notifications,
    statuses,
    handler: createBranchSummaryHandler(PROVIDER_ID),
    context,
    event,
  };
}

describe("segmented branch summary", () => {
  it("defers to Pi's branch summary when one request has output room", async () => {
    const harness = createHarness({ entryList: entries(6, 200), contextWindow: 200_000 });

    await expect(harness.handler(harness.event, harness.context)).resolves.toBeUndefined();
    expect(harness.calls).toHaveLength(0);
  });

  it("leaves other providers to Pi's branch summary", async () => {
    const harness = createHarness({ provider: "anthropic", contextWindow: 40_000 });

    await expect(harness.handler(harness.event, harness.context)).resolves.toBeUndefined();
    expect(harness.calls).toHaveLength(0);
  });

  it("stays out of the way when the user asked for no summary", async () => {
    const harness = createHarness({ contextWindow: 40_000, userWantsSummary: false });

    await expect(harness.handler(harness.event, harness.context)).resolves.toBeUndefined();
    expect(harness.calls).toHaveLength(0);
  });

  it("answers with Pi's empty-branch text when no entry carries a message", async () => {
    const harness = createHarness({
      contextWindow: 40_000,
      entryList: [
        {
          type: "model_change",
          id: "entry-0",
          parentId: null,
          timestamp: new Date(0).toISOString(),
          provider: PROVIDER_ID,
          modelId: "free-model",
        },
      ],
    });

    const result = await harness.handler(harness.event, harness.context);

    expect(result?.summary?.summary).toBe("No content to summarize");
    expect(harness.calls).toHaveLength(0);
  });

  it("summarizes a branch that a single request cannot cover", async () => {
    const harness = createHarness({ contextWindow: 40_000 });

    const result = await harness.handler(harness.event, harness.context);

    const summary = result?.summary?.summary ?? "";

    expect(summary.startsWith("The user explored a different conversation branch")).toBe(true);
    expect(summary).toContain("## Goal");
    expect(summary).toContain("## Next Steps");
    expect(harness.calls.length).toBeGreaterThanOrEqual(3);
    expect(harness.calls.at(-1)?.prompt).toContain("DIGEST-");
    expect(harness.notifications.join(" ")).toContain("Summarized branch");
    expect(harness.statuses.at(-1)).toBeUndefined();
  });

  it("reports the usage it spent and the files the branch touched", async () => {
    const harness = createHarness({ contextWindow: 40_000 });

    const result = await harness.handler(harness.event, harness.context);

    expect(result?.summary?.usage?.totalTokens).toBe(USAGE.totalTokens * harness.calls.length);
    expect(result?.summary?.details).toEqual({ readFiles: [], modifiedFiles: [] });
  });

  it("carries file lists from nested branch summaries into the new one", async () => {
    const nested: SessionEntry = {
      type: "branch_summary",
      id: "entry-summary",
      parentId: null,
      timestamp: new Date(0).toISOString(),
      fromId: "entry-0",
      summary: "earlier exploration",
      details: { readFiles: ["src/nested-read.ts"], modifiedFiles: ["src/nested-written.ts"] },
    };

    const harness = createHarness({
      contextWindow: 40_000,
      entryList: [nested, ...entries(60, 2_000)],
    });

    const result = await harness.handler(harness.event, harness.context);

    expect(result?.summary?.details?.readFiles).toContain("src/nested-read.ts");
    expect(result?.summary?.details?.modifiedFiles).toContain("src/nested-written.ts");
    expect(result?.summary?.summary).toContain(
      "<modified-files>\nsrc/nested-written.ts\n</modified-files>",
    );
  });

  it("appends custom instructions as focus, as Pi does", async () => {
    const harness = createHarness({
      contextWindow: 40_000,
      customInstructions: "focus on the parser rewrite",
    });

    await harness.handler(harness.event, harness.context);

    expect(harness.calls.at(-1)?.prompt).toContain("Additional focus: focus on the parser rewrite");
    expect(harness.calls.at(-1)?.prompt).toContain("## Next Steps");
    // The branch format has no critical-context section, unlike a compaction checkpoint.
    expect(harness.calls.at(-1)?.prompt).not.toContain("## Critical Context");
  });

  it("uses custom instructions as the whole prompt when Pi replaces them", async () => {
    const harness = createHarness({
      contextWindow: 40_000,
      customInstructions: "List only the files that changed.",
      replaceInstructions: true,
    });

    const result = await harness.handler(harness.event, harness.context);

    expect(harness.calls.at(-1)?.prompt).toContain("List only the files that changed.");
    expect(harness.calls.at(-1)?.prompt).not.toContain("Use this EXACT format:");
    expect(harness.calls.at(-1)?.prompt).not.toContain("Additional focus:");
    expect(result?.summary?.summary).toContain("## Goal");
  });

  it("never asks for a thinking level or an answer cap", async () => {
    const harness = createHarness({ contextWindow: 40_000 });

    await harness.handler(harness.event, harness.context);

    for (const call of harness.calls) {
      expect(call.reasoning).toBe(false);
      expect(call.carriesCap).toBe(false);
    }
  });

  it("defers when every segment digest comes back empty", async () => {
    const harness = createHarness({
      contextWindow: 40_000,
      respond: () => response("", "stop"),
    });

    const result = await harness.handler(harness.event, harness.context);

    expect(result).toBeUndefined();
    expect(harness.notifications.join(" ")).toContain("no digests");
  });

  it("discards a summary that stopped at the cap and defers to Pi", async () => {
    const harness = createHarness({
      contextWindow: 40_000,
      respond: (call, index) =>
        isSummaryRequest(call)
          ? response(BRANCH_SUMMARY, "length")
          : response(`DIGEST-${index + 1}`, "stop"),
    });

    const result = await harness.handler(harness.event, harness.context);

    expect(result).toBeUndefined();
    expect(harness.notifications.join(" ")).toContain("no usable summary");
  });

  it("re-asks once when the summary skips the template, then accepts it", async () => {
    let attempts = 0;

    const harness = createHarness({
      contextWindow: 40_000,
      respond: (call, index) => {
        if (!isSummaryRequest(call)) return response(`DIGEST-${index + 1}`, "stop");

        attempts += 1;

        return response(attempts === 1 ? "A prose summary." : BRANCH_SUMMARY, "stop");
      },
    });

    const result = await harness.handler(harness.event, harness.context);

    expect(attempts).toBe(2);
    expect(harness.calls.at(-1)?.prompt).toContain("did not fill in the required");
    expect(result?.summary?.summary).toContain("## Goal");
  });

  it("cancels the navigation when the summary is aborted", async () => {
    const controller = new AbortController();

    const harness = createHarness({
      contextWindow: 40_000,
      signal: controller.signal,
      respond: () => {
        controller.abort();

        return new Error("aborted");
      },
    });

    await expect(harness.handler(harness.event, harness.context)).resolves.toEqual({
      cancel: true,
    });
  });

  it("reports a failed request and defers to Pi", async () => {
    const harness = createHarness({
      contextWindow: 40_000,
      respond: () => new Error("stream closed"),
    });

    const result = await harness.handler(harness.event, harness.context);

    expect(result).toBeUndefined();
    expect(harness.notifications.join(" ")).toContain(
      "Segmented branch summary failed: stream closed",
    );
  });

  it("registers the tree hook with the routing session id and no reasoning", async () => {
    const requests: SimpleStreamOptions[] = [];
    const notifications: string[] = [];
    const statuses: (string | undefined)[] = [];

    const model = {
      id: "free-model",
      name: "Free model",
      provider: PROVIDER_ID,
      api: "openai-completions",
      contextWindow: 40_000,
      maxTokens: 32_000,
      input: ["text"],
      reasoning: true,
      baseUrl: "https://example.invalid",
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    } as const satisfies Model<Api>;

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
                      {
                        type: "text",
                        text: requests.length === 1 ? "DIGEST-1" : BRANCH_SUMMARY,
                      },
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
              if (name === "session_before_tree") registered = handler;

              return () => {};
            };
          }

          return undefined;
        },
      },
    );

    // SAFETY: the proxy supplies the ExtensionAPI member registration reads.
    registerBranchSummary(pi as ExtensionAPI, PROVIDER_ID, {
      createSessionId: () => "routing-id",
    });

    const harness = createHarness({ contextWindow: 40_000 });
    // SAFETY: the proxy supplies the ExtensionContext members the adapter reads.
    const result = await registered?.(harness.event, context as ExtensionContext);

    expect(result?.summary).toBeDefined();
    expect(requests.length).toBeGreaterThan(0);

    for (const request of requests) {
      expect(Object.hasOwn(request, "reasoning")).toBe(false);
      expect(request.cacheRetention).toBe("none");
      expect(request.sessionId).toBe("routing-id");
    }

    expect(notifications.join(" ")).toContain("Summarized branch");
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
              if (name === "session_before_tree") registered = handler;

              return () => {};
            };
          }

          return undefined;
        },
      },
    );

    // SAFETY: the proxy supplies the ExtensionAPI member registration reads.
    registerBranchSummary(pi as ExtensionAPI, PROVIDER_ID);

    const harness = createHarness({ contextWindow: 40_000 });
    // SAFETY: the proxy supplies the ExtensionContext members the adapter reads.
    const result = await registered?.(harness.event, context as ExtensionContext);

    expect(result).toBeUndefined();
    expect(requests).toBe(0);
  });
});
