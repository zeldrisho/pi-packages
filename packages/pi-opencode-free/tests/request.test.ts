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
    expect(result.tools).toEqual([
      expect.objectContaining({ function: expect.objectContaining({ name: "read" }) }),
    ]);
    expect(payload.stream).toBe(false);
    expect(payload.tools).toBeUndefined();
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

  it("appends read when another tool is already declared", () => {
    const payload: ProviderRequestPayload = {
      model: "beam-free",
      tools: [{ type: "function", function: { name: "bash" } }],
    };

    const result = normalizeFreeRequestPayload(payload);

    expect(result.tools?.map((tool) => tool.function?.name)).toEqual(["bash", "read"]);
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
  });
});
