import type { AssistantMessage, Message, Tool, ToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vite-plus/test";

import { resolveIdentity } from "../src/ids";
import type { AntigravityModel } from "../src/models";
import {
  buildContents,
  buildRequest,
  buildTools,
  compatibleSystemPrompt,
  normalizeSchema,
  parseImageData,
  sanitizeToolCallId,
  type RequestInput,
} from "../src/request";

const identity = resolveIdentity("session-under-test");

const gemini: AntigravityModel = {
  id: "gemini-3.8-flash",
  name: "Gemini 3.8 Flash",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 128_000,
  maxTokens: 32_768,
  thinkingLevelMap: {
    off: null,
    minimal: null,
    low: "gemini-3.8-flash-low",
    medium: "gemini-3.8-flash-medium",
    high: "gemini-3.8-flash-high",
    xhigh: null,
    max: null,
  },
};

const claude = gemini;

const gptOssModel = gemini;

function requireModel(model: AntigravityModel): AntigravityModel {
  return model;
}

function userMessage(text: string): Message {
  return { role: "user", content: text, timestamp: 1 };
}

function assistantMessage(content: AssistantMessage["content"], model: string): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "antigravity",
    provider: "antigravity",
    model,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 2,
  };
}

function toolCall(id: string, name: string, args: Record<string, string>): ToolCall {
  return { type: "toolCall", id, name, arguments: args };
}

function toolResult(id: string, name: string, text: string): Message {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 3,
  };
}

const BAKE_BREAD: Tool = {
  name: "bake_bread",
  description: "Bakes bread",
  parameters: {
    type: "object",
    properties: { loaves: { type: "number", description: "How many loaves" } },
    required: ["loaves"],
  },
};

function input(overrides: Partial<RequestInput> = {}): RequestInput {
  return {
    model: requireModel(gemini),
    messages: [userMessage("Bake two loaves")],
    systemPrompt: "You are a baker.",
    tools: [],
    projectId: "project-under-test",
    runtimeModel: "gemini-3.8-flash-low",
    identity,
    requestIndex: 0,
    now: 1_700_000_000_000,
    ...overrides,
  };
}

describe("content conversion", () => {
  it("converts text and image user messages", () => {
    const contents = buildContents(
      input({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Describe this" },
              { type: "image", data: "aGVsbG8=", mimeType: "image/jpeg" },
            ],
            timestamp: 1,
          },
        ],
      }),
    );

    expect(contents).toEqual([
      {
        role: "user",
        parts: [
          { text: "Describe this" },
          { inlineData: { mimeType: "image/jpeg", data: "aGVsbG8=" } },
        ],
      },
    ]);
  });

  it("keeps a model turn and its tool result in order", () => {
    const contents = buildContents(
      input({
        model: requireModel(gptOssModel),
        runtimeModel: "gpt-oss-120b-medium",
        messages: [
          userMessage("Bake two loaves"),
          assistantMessage([toolCall("call-1", "bake_bread", { loaves: "2" })], "gpt-oss-120b"),
          toolResult("call-1", "bake_bread", "Two loaves are ready"),
        ],
      }),
    );

    expect(contents).toHaveLength(3);
    expect(contents[1]?.role).toBe("model");
    expect(contents[1]?.parts[0]).toEqual({
      functionCall: { name: "bake_bread", args: { loaves: "2" } },
    });
    expect(contents[2]).toEqual({
      role: "user",
      parts: [
        {
          functionResponse: {
            name: "bake_bread",
            response: { output: "Two loaves are ready" },
          },
        },
      ],
    });
  });

  it("keeps Gemini tool calls in the native schema", () => {
    const contents = buildContents(
      input({
        model: requireModel(claude),
        runtimeModel: "claude-opus-4-6-thinking",
        messages: [
          userMessage("Bake two loaves"),
          assistantMessage([toolCall("call/1", "bake_bread", { loaves: "2" })], "claude-opus-4-6"),
          toolResult("call/1", "bake_bread", "Two loaves are ready"),
        ],
      }),
    );

    expect(contents[1]?.parts[0]).toEqual({
      functionCall: { name: "bake_bread", args: { loaves: "2" } },
    });
    expect(contents[2]?.parts[0]).toEqual({
      functionResponse: {
        name: "bake_bread",
        response: { output: "Two loaves are ready" },
      },
    });
  });

  it("drops unsigned tool calls for Gemini 3 and reports them as observations", () => {
    const contents = buildContents(
      input({
        messages: [
          userMessage("Bake two loaves"),
          assistantMessage([toolCall("call-1", "bake_bread", { loaves: "2" })], "gemini-3.8-flash"),
          toolResult("call-1", "bake_bread", "Two loaves are ready"),
        ],
        runtimeModel: "gemini-3.8-flash-low",
        model: requireModel(gemini),
      }),
    );

    // Gemini 3 requires a signature, so the call is dropped, its result becomes
    // observation text, and the two adjacent user turns merge.
    expect(contents).toEqual([
      {
        role: "user",
        parts: [
          { text: "Bake two loaves" },
          { text: '[Observation from `bake_bread` ({"loaves":"2"}):\nTwo loaves are ready]' },
        ],
      },
    ]);
  });

  it("replays signed tool calls and thinking for the same model", () => {
    const signature = "c2lnbmF0dXJl";

    const contents = buildContents(
      input({
        messages: [
          userMessage("Bake two loaves"),
          assistantMessage(
            [
              { type: "thinking", thinking: "Plan the bake", thinkingSignature: signature },
              { ...toolCall("call-1", "bake_bread", { loaves: "2" }), thoughtSignature: signature },
            ],
            "gemini-3.8-flash",
          ),
          toolResult("call-1", "bake_bread", "Two loaves are ready"),
        ],
      }),
    );

    expect(contents[1]?.parts).toEqual([
      { thought: true, text: "Plan the bake", thoughtSignature: signature },
      {
        functionCall: { name: "bake_bread", args: { loaves: "2" } },
        thoughtSignature: signature,
      },
    ]);
  });

  it("omits unsigned Claude thinking while keeping its answer on follow-up", () => {
    const contents = buildContents(
      input({
        model: requireModel(claude),
        runtimeModel: "claude-opus-4-6-thinking",
        messages: [
          userMessage("Who are you?"),
          assistantMessage(
            [
              { type: "thinking", thinking: "Private reasoning without a signature" },
              { type: "text", text: "A coding assistant." },
            ],
            "claude-opus-4-6",
          ),
          userMessage("Not in Pi?"),
        ],
      }),
    );

    expect(contents).toEqual([
      { role: "user", parts: [{ text: "Who are you?" }] },
      { role: "model", parts: [{ text: "A coding assistant." }] },
      { role: "user", parts: [{ text: "Not in Pi?" }] },
    ]);
  });

  it("keeps text history from another provider but drops its reasoning", () => {
    const foreign = assistantMessage(
      [{ type: "text", text: "Foreign answer" }],
      "gemini-3.8-flash",
    );

    const contents = buildContents(
      input({
        messages: [
          userMessage("Bake two loaves"),
          {
            ...foreign,
            provider: "other-provider",
            content: [
              { type: "thinking", thinking: "Foreign reasoning" },
              { type: "text", text: "Foreign answer" },
            ],
          },
          userMessage("Continue"),
        ],
      }),
    );

    expect(contents[1]).toEqual({ role: "model", parts: [{ text: "Foreign answer" }] });
  });

  it("omits failed turns from history", () => {
    const failed = {
      ...assistantMessage([{ type: "text", text: "Boom" }], "gemini-3.8-flash"),
      stopReason: "error" as const,
    };

    const contents = buildContents(
      input({ messages: [userMessage("Bake two loaves"), failed, userMessage("Try again")] }),
    );

    // Consecutive user turns merge, so the failed answer leaves no model turn behind.
    expect(contents).toEqual([
      { role: "user", parts: [{ text: "Bake two loaves" }, { text: "Try again" }] },
    ]);
  });

  it("adds a continuation turn when history ends with a model turn", () => {
    const contents = buildContents(
      input({
        messages: [
          userMessage("Bake two loaves"),
          assistantMessage([{ type: "text", text: "Done" }], "gemini-3.8-flash"),
        ],
      }),
    );

    expect(contents.at(-1)?.role).toBe("user");
  });

  it("adds a user turn before a leading tool call", () => {
    const contents = buildContents(
      input({
        messages: [assistantMessage([toolCall("call-1", "bake_bread", { loaves: "2" })], "x")],
      }),
    );

    expect(contents[0]?.role).toBe("user");
  });
});

describe("schema normalization", () => {
  it("inlines local references and strips metadata without confusing property names for keywords", () => {
    const schema = normalizeSchema({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      $defs: { Loaves: { type: "number" } },
      properties: {
        loaves: { $ref: "#/$defs/Loaves" },
        $ref: { type: "string" },
        items: { type: "array", items: { type: "string" } },
      },
    });

    expect(schema).toEqual({
      type: "object",
      properties: {
        loaves: { type: "number" },
        $ref: { type: "string" },
        items: { type: "array", items: { type: "string" } },
      },
    });
  });

  it("bounds circular references", () => {
    const schema = normalizeSchema({
      type: "object",
      $defs: { Node: { $ref: "#/$defs/Node" } },
      properties: { node: { $ref: "#/$defs/Node" } },
    });

    expect(schema).toEqual({ type: "object", properties: { node: {} } });
  });

  it("preserves reserved names as own data properties through normalization and serialization", () => {
    const key = "__proto__";

    const schema = normalizeSchema({
      type: "object",
      [key]: { description: "Custom keyword" },
      $defs: { Name: { type: "string", $id: "urn:test:name" } },
      properties: {
        [key]: { $ref: "#/$defs/Name" },
        constructor: { type: "number" },
        prototype: { type: "boolean" },
      },
    });

    expect(Object.getPrototypeOf(schema)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(schema.properties)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(schema, key)?.value).toEqual({
      description: "Custom keyword",
    });
    expect(Object.getOwnPropertyDescriptor(schema.properties, key)?.value).toEqual({
      type: "string",
    });
    expect(JSON.stringify(schema)).toBe(
      JSON.stringify({
        type: "object",
        [key]: { description: "Custom keyword" },
        properties: {
          [key]: { type: "string" },
          constructor: { type: "number" },
          prototype: { type: "boolean" },
        },
      }),
    );
  });

  it("builds Gemini declarations with a JSON schema", () => {
    const tools = buildTools([BAKE_BREAD]);

    expect(tools?.[0]?.functionDeclarations[0]?.parametersJsonSchema).toBeDefined();
    expect(tools?.[0]?.functionDeclarations[0]?.parameters).toBeUndefined();
    expect(buildTools([])).toBeUndefined();
  });
});

describe("system prompt compatibility", () => {
  it("rephrases the exact default preamble and preserves the rest", () => {
    const prompt =
      "You are a coding assistant running inside pi, a coding agent harness. Help users inspect files.\n<rules>Keep these instructions.</rules>";

    const expected =
      "You are a coding assistant in a development environment. Help users inspect files.\n<rules>Keep these instructions.</rules>";

    expect(compatibleSystemPrompt(prompt)).toBe(expected);
    expect(
      buildRequest(input({ systemPrompt: prompt })).request.systemInstruction.parts[0]?.text,
    ).toBe(expected);
  });

  it("rephrases the matching documentation phrase only in the default prompt", () => {
    const preamble = "You are a coding assistant running inside pi, a coding agent harness.";
    const phrase = "non-LLM models such as classifiers and image models";

    expect(
      compatibleSystemPrompt(`${preamble} codemode scripts and ${phrase} (docs/codemode.md)`),
    ).toBe(
      "You are a coding assistant in a development environment. codemode scripts and classifiers and image models (docs/codemode.md)",
    );
    expect(compatibleSystemPrompt(`Custom instructions: ${phrase}`)).toBe(
      `Custom instructions: ${phrase}`,
    );
  });

  it("leaves custom prompts and embedded mentions unchanged", () => {
    const custom =
      "Custom instructions: You are a coding assistant running inside pi, a coding agent harness.";

    expect(compatibleSystemPrompt(custom)).toBe(custom);
    expect(compatibleSystemPrompt("You are a coding assistant running inside pi.js.")).toBe(
      "You are a coding assistant running inside pi.js.",
    );
    expect(compatibleSystemPrompt("")).toBe("");
  });
});

describe("envelope assembly", () => {
  it("carries the project, runtime model, and identity", () => {
    const envelope = buildRequest(input({ tools: [BAKE_BREAD], thinkingLevel: "high" }));
    const step = envelope.request.contents.length;

    expect(envelope.project).toBe("project-under-test");
    expect(envelope.model).toBe("gemini-3.8-flash-low");
    expect(envelope.requestType).toBe("agent");
    expect(envelope.userAgent).toBe("antigravity");
    expect(envelope.requestId).toBe(
      `agent/${identity.conversationId}/1700000000000/${identity.trajectoryId}/${step}`,
    );
    expect(envelope).not.toHaveProperty("sessionId");
    expect(envelope).not.toHaveProperty("labels");
    expect(envelope.request.sessionId).toBe(identity.sessionId);
    expect(envelope.request.labels.last_step_index).toBe(String(step - 1));
    expect(envelope.request.labels.request_id).toBe(`${identity.trajectoryId}-0`);
    expect(envelope.request.labels.used_claude).toBe("false");
    expect(envelope.request.labels.used_claude_conservative).toBe("false");
    expect(envelope.request.labels.used_non_gemini_model).toBe("false");
    expect(envelope.request.systemInstruction).toEqual({
      role: "user",
      parts: [{ text: "You are a baker." }],
    });
    expect(envelope.request.generationConfig?.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: "LOW",
    });
    expect(envelope.request.generationConfig?.maxOutputTokens).toBe(requireModel(gemini).maxTokens);
  });

  it("clamps the output limit to the model ceiling", () => {
    const capped = { ...requireModel(gemini), maxTokens: 1_024 };
    const envelope = buildRequest(input({ model: capped, maxTokens: 999_999 }));

    expect(envelope.request.generationConfig?.maxOutputTokens).toBe(1_024);
  });

  it("marks non-Gemini requests through labels", () => {
    const envelope = buildRequest(
      input({ model: requireModel(claude), runtimeModel: "claude-opus-4-6-thinking" }),
    );

    expect(envelope.request.labels.used_non_gemini_model).toBe("true");
  });
});

describe("small helpers", () => {
  it("sanitizes tool-call ids", () => {
    expect(sanitizeToolCallId("call/1", "tool")).toBe("call_1");
    expect(sanitizeToolCallId("", "bake_bread")).toBe("bake_bread_call");
    expect(sanitizeToolCallId("a".repeat(80), "tool")).toHaveLength(64);
  });

  it("parses data URLs and bare base64 payloads", () => {
    expect(parseImageData("data:image/png;base64,AAAA")).toEqual({
      mimeType: "image/png",
      data: "AAAA",
    });
    expect(parseImageData("AAAA", "image/webp")).toEqual({ mimeType: "image/webp", data: "AAAA" });
    expect(parseImageData("  AAAA  ")).toEqual({ mimeType: "image/png", data: "AAAA" });
  });
});
