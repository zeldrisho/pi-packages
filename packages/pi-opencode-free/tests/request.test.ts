import { describe, expect, it } from "vite-plus/test";

import {
  isProviderRequestPayload,
  normalizeFreeRequestPayload,
  type ProviderRequestPayload,
} from "../src/request";

describe("free-tier request normalization", () => {
  it("forces streaming without mutating the original payload", () => {
    const payload: ProviderRequestPayload = {
      model: "big-pickle",
      stream: false,
      temperature: 0.2,
    };

    expect(isProviderRequestPayload(payload)).toBe(true);

    const result = normalizeFreeRequestPayload(payload);

    expect(result.stream).toBe(true);
    expect(result.temperature).toBe(0.2);
    expect(result.tools).toBeUndefined();
    expect(payload.stream).toBe(false);
    expect(payload.tools).toBeUndefined();
  });

  it("preserves an explicitly empty toolset", () => {
    const payload: ProviderRequestPayload = { model: "big-pickle", tools: [] };

    const result = normalizeFreeRequestPayload(payload);

    expect(result.tools).toBe(payload.tools);
    expect(result.tools).toEqual([]);
  });

  it("reuses an existing read declaration", () => {
    const payload: ProviderRequestPayload = {
      model: "beam-free",
      tools: [
        { type: "function", function: { name: "bash" } },
        { type: "function", function: { name: "read", description: "custom" } },
      ],
    };

    expect(isProviderRequestPayload(payload)).toBe(true);

    const result = normalizeFreeRequestPayload(payload);

    expect(result.tools).toHaveLength(2);
    expect(result.tools?.[1]?.function?.name).toBe("read");
  });

  it("preserves another tool without appending read", () => {
    const payload: ProviderRequestPayload = {
      model: "beam-free",
      tools: [{ type: "function", function: { name: "bash" } }],
    };

    const result = normalizeFreeRequestPayload(payload);

    expect(result.tools?.map((tool) => tool.function?.name)).toEqual(["bash"]);
  });

  it("removes both forms of the rejected none tool choice", () => {
    const stringChoice: ProviderRequestPayload = {
      model: "glm-5.3-flash-free",
      tool_choice: "none",
    };

    const objectChoice: ProviderRequestPayload = {
      model: "glm-5.3-flash-free",
      tool_choice: { type: "none" },
    };

    expect(normalizeFreeRequestPayload(stringChoice)).not.toHaveProperty("tool_choice");
    expect(normalizeFreeRequestPayload(objectChoice)).not.toHaveProperty("tool_choice");
  });

  it("preserves supported tool choices and token limits", () => {
    const payload: ProviderRequestPayload = {
      model: "flint-40b-free",
      tool_choice: "auto",
      max_tokens: 2048,
    };

    const result = normalizeFreeRequestPayload(payload);

    expect(result.tool_choice).toBe("auto");
    expect(result.max_tokens).toBe(2048);
  });

  it("rejects payloads that cannot be normalized safely", () => {
    expect(isProviderRequestPayload(null)).toBe(false);
    expect(isProviderRequestPayload({})).toBe(false);
    expect(isProviderRequestPayload({ model: 1 })).toBe(false);
    expect(isProviderRequestPayload({ model: "x", stream: "yes" })).toBe(false);
    expect(isProviderRequestPayload({ model: "x", tools: "read" })).toBe(false);
    expect(isProviderRequestPayload({ model: "x", tools: [{ type: "function" }] })).toBe(false);
    expect(isProviderRequestPayload({ model: "x", tools: [{ function: { name: 1 } }] })).toBe(
      false,
    );
    expect(isProviderRequestPayload({ model: "x", tool_choice: 1 })).toBe(false);
    expect(isProviderRequestPayload({ model: "x", messages: "invalid" })).toBe(false);
    expect(isProviderRequestPayload({ model: "x", messages: {} })).toBe(false);
    expect(isProviderRequestPayload({ model: "x", messages: [] })).toBe(true);
  });
});

describe("prompt preservation", () => {
  it("prefixes a minimal env block and preserves the prompt", () => {
    const messages = [
      { role: "system", content: "You are Pi." },
      { role: "user", content: "Hi" },
    ];

    const result = normalizeFreeRequestPayload({ model: "beam-free", messages });
    expect(result.messages?.[0]?.content).toBe(
      `<env>\n Working directory: ${process.cwd()}\n</env>\n\nYou are Pi.`,
    );
    expect(messages[0]?.content).toBe("You are Pi.");
  });
  it("recognizes structured env content without matching text outside a block", () => {
    const structured = [
      {
        role: "system",
        content: [{ type: "text", text: "<env>\n Working directory: /tmp\n</env>" }],
      },
    ];

    expect(normalizeFreeRequestPayload({ model: "x", messages: structured }).messages).toBe(
      structured,
    );
    const messages = [{ role: "system", content: "<env>nothing</env> Working directory: /tmp" }];
    expect(normalizeFreeRequestPayload({ model: "x", messages }).messages).not.toBe(messages);
  });
  it("does not duplicate an existing env block in any instruction", () => {
    const messages = [
      { role: "system", content: "Pi" },
      { role: "developer", content: "<env>\n Working directory: /tmp\n</env>" },
    ];

    expect(normalizeFreeRequestPayload({ model: "beam-free", messages }).messages).toBe(messages);
  });
});

describe("working directory block", () => {
  it("replaces Pi's cwd block instead of adding a second directory block", () => {
    const prompt = "You are Pi.\n\n<cwd>\n/workspace/project\n</cwd>\n\nFollow the rules.";

    const messages = [
      { role: "system", content: prompt },
      { role: "user", content: "Hi" },
    ];

    const result = normalizeFreeRequestPayload({ model: "beam-free", messages });
    const content = String(result.messages?.[0]?.content);

    expect(content).toBe(
      "You are Pi.\n\n<env>\n Working directory: /workspace/project\n</env>\n\nFollow the rules.",
    );
    expect(content).not.toContain("<cwd>");
    expect(content.match(/Working directory:/gu)).toHaveLength(1);
    expect(messages[0]?.content).toBe(prompt);
    expect(result.messages?.[1]).toBe(messages[1]);
  });

  it("keeps Pi's cwd block available for other providers", () => {
    const messages = [{ role: "system", content: "<cwd>\n/workspace\n</cwd>" }];

    normalizeFreeRequestPayload({ model: "beam-free", messages });

    expect(messages[0]?.content).toBe("<cwd>\n/workspace\n</cwd>");
  });

  it("converts the cwd block of structured content without mutating it", () => {
    const content = [
      { type: "text", text: "<cwd>\n/workspace\n</cwd>" },
      { type: "text", text: "tail" },
    ];

    const result = normalizeFreeRequestPayload({
      model: "beam-free",
      messages: [{ role: "developer", content }],
    });

    expect(result.messages?.[0]?.content).toEqual([
      { type: "text", text: "<env>\n Working directory: /workspace\n</env>" },
      { type: "text", text: "tail" },
    ]);
    expect(content[0]?.text).toBe("<cwd>\n/workspace\n</cwd>");
  });

  it("converts a cwd block in a later instruction message in place", () => {
    const messages = [
      { role: "system", content: "Pi" },
      { role: "developer", content: "<cwd>\n/workspace\n</cwd>" },
    ];

    const result = normalizeFreeRequestPayload({ model: "beam-free", messages });

    expect(result.messages?.[0]?.content).toBe("Pi");
    expect(result.messages?.[1]?.content).toBe("<env>\n Working directory: /workspace\n</env>");
  });

  it("flattens malformed cwd paths that would close the env block early", () => {
    const messages = [{ role: "system", content: "<cwd>\n/tmp\n<bad>\n</cwd>" }];

    const result = normalizeFreeRequestPayload({ model: "beam-free", messages });

    expect(result.messages?.[0]?.content).toBe("<env>\n Working directory: /tmp bad\n</env>");
  });

  it("falls back to the process directory for an empty cwd block", () => {
    const messages = [{ role: "system", content: "<cwd>\n\n</cwd>" }];

    const result = normalizeFreeRequestPayload({ model: "beam-free", messages });

    expect(result.messages?.[0]?.content).toBe(
      `<env>\n Working directory: ${process.cwd()}\n</env>`,
    );
  });

  it("leaves a cwd block in a user message untouched", () => {
    const messages = [{ role: "user", content: "<cwd>\n/workspace\n</cwd>" }];

    const result = normalizeFreeRequestPayload({ model: "beam-free", messages });

    expect(result.messages?.[1]?.content).toBe("<cwd>\n/workspace\n</cwd>");
    expect(result.messages?.[0]?.content).toBe(
      `<env>\n Working directory: ${process.cwd()}\n</env>`,
    );
  });
});
