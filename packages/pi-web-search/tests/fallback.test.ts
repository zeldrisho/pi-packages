import { describe, expect, it, vi } from "vite-plus/test";
import { Check } from "typebox/value";
import { webSearchOutputSchema } from "../src/search";
import { answerResponse, createSearchTool, jsonResponse } from "./harness";

describe("generated-answer fallback", () => {
  it("isolates direct and fallback answer caches and respects credential removal", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "fallback-web-secret";
    process.env.BRAVE_ANSWERS_API_KEY = "fallback-answers-secret";

    const requests: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      requests.push(path);

      return path === "/res/v1/chat/completions"
        ? answerResponse([
            'Claim. <citation>{"number":1,"url":"https://example.com/source"}</citation>',
          ])
        : jsonResponse({ web: { results: [] } });
    });

    const tool = createSearchTool();
    const params = { query: "fallback-policy-and-caching" };
    const answerParams = { ...params, mode: "answers" } as const;
    const direct = await tool.execute("direct", answerParams, undefined, undefined);
    const cachedDirect = await tool.execute("cached-direct", answerParams, undefined, undefined);
    expect(cachedDirect.details.cached).toBe(true);
    expect(cachedDirect.content).toEqual(direct.content);
    expect(cachedDirect.details.answer).toEqual(direct.details.answer);

    const first = await tool.execute("first", params, undefined, undefined);

    expect(Check(webSearchOutputSchema, first.structuredContent)).toBe(true);
    expect(first.structuredContent).toMatchObject({
      resultType: "generated-answer",
      cached: false,
      payloadOmitted: false,
      answer: { text: "Claim. [1]", citations: [{ number: 1, url: "https://example.com/source" }] },
    });
    expect(first.content[0]?.text).toContain("## No web results. AI-generated answer:");
    expect(first.content[0]?.text).not.toContain(params.query);

    const cached = await tool.execute("cached", params, undefined, undefined);
    expect(cached.structuredContent).toMatchObject({
      resultType: "generated-answer",
      cached: true,
    });

    delete process.env.BRAVE_ANSWERS_API_KEY;
    const disabled = await tool.execute("disabled", params, undefined, undefined);
    expect(disabled.structuredContent).toMatchObject({
      resultType: "search-results",
      cached: true,
      results: [],
    });
    expect(disabled.structuredContent).not.toHaveProperty("answer");
    expect(requests).toEqual([
      "/res/v1/chat/completions",
      "/res/v1/web/search",
      "/res/v1/chat/completions",
    ]);
  });

  it("does not request a generated answer without an Answers key", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "policy-web-secret";
    delete process.env.BRAVE_ANSWERS_API_KEY;

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();

      if (url.includes("/chat/completions")) return answerResponse(["unexpected answer"]);

      return jsonResponse({ web: { results: [] } });
    });

    vi.stubGlobal("fetch", fetchMock);

    const result = await createSearchTool().execute(
      "call",
      { query: "policy-off-no-fallback" },
      undefined,
      undefined,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.structuredContent).toMatchObject({
      resultType: "search-results",
      results: [],
    });
    expect(result.content[0].text).toContain("No web results for");
  });
});
