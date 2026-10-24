import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { Check } from "typebox/value";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { executeWebFetch, type FetchRemoteDependencies } from "../src/index";
import { webFetchOutputSchema } from "../src/service";
import { createFetchHarness } from "./harness";

describe("web_fetch structured output", () => {
  const fixture = createFetchHarness();
  let origin = "";
  let dependencies: FetchRemoteDependencies;

  beforeAll(async () => {
    await fixture.start();
    origin = fixture.origin();
    dependencies = fixture.dependencies();
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it("returns a schema-compatible result alongside model-facing text", async () => {
    const result = await executeWebFetch(
      { url: `${origin}/html` },
      undefined,
      undefined,
      dependencies,
    );

    expect(result.structuredContent).toBeDefined();
    expect(Check(webFetchOutputSchema, result.structuredContent)).toBe(true);
    expect(result.structuredContent).toMatchObject({
      requestedUrl: `${origin}/html`,
      finalUrl: `${origin}/html`,
      contentType: "text/html",
      extractor: "defuddle",
      contentKind: "article",
      cacheStatus: "miss",
      blocked: false,
      truncated: false,
      llmsTxtFallback: false,
      markdownAlternateFallback: false,
    });

    // SAFETY: the emitted JSON value passed the declared output schema above.
    const structured = result.structuredContent as {
      markdown: string;
      outline: { totalHeadings: number };
    };

    expect(structured.markdown).toContain("Hello");
    expect(structured.markdown).toContain("World");
    expect(structured.outline.totalHeadings).toBeGreaterThan(0);
    expect(result.content[0].text).toContain("Hello");
  });

  it("uses structured continuation offsets without skipping JSON-escaped content", async () => {
    let offset = 0;
    let received = "";
    let calls = 0;

    while (received.length < 40_000 && calls < 20) {
      const result = await executeWebFetch(
        { url: `${origin}/escaped-text`, offset, maxCharacters: 30_000 },
        undefined,
        undefined,
        dependencies,
      );

      expect(Check(webFetchOutputSchema, result.structuredContent)).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(result.structuredContent))).toBeLessThanOrEqual(
        DEFAULT_MAX_BYTES,
      );

      // SAFETY: the emitted value passed the schema check above.
      const structured = result.structuredContent as {
        markdown: string;
        offset: number;
        characterCount: number;
        nextOffset?: number;
        truncated: boolean;
      };

      expect(structured.offset).toBe(offset);
      expect(structured.characterCount).toBe(structured.markdown.length);
      received += structured.markdown;
      calls += 1;

      if (structured.nextOffset === undefined) {
        expect(structured.truncated).toBe(false);
        break;
      }

      expect(structured.nextOffset).toBe(offset + structured.markdown.length);
      expect(structured.nextOffset).toBeGreaterThan(offset);
      offset = structured.nextOffset;
    }

    expect(calls).toBeGreaterThan(1);
    expect(received).toBe("\u0001".repeat(40_000));
  });

  it("returns focused and cached metadata without changing the canonical document", async () => {
    const focused = await executeWebFetch(
      { url: `${origin}/focused`, query: "Redirect" },
      undefined,
      undefined,
      dependencies,
    );

    expect(focused.structuredContent).toMatchObject({
      focus: { query: "Redirect", matchedSections: 1 },
      markdown: expect.stringContaining("Redirect targets"),
    });

    const complete = await executeWebFetch(
      { url: `${origin}/focused` },
      undefined,
      undefined,
      dependencies,
    );

    expect(complete.structuredContent).toMatchObject({
      cacheStatus: "hit",
      markdown: expect.stringContaining("Installation"),
    });
    expect(complete.structuredContent).not.toHaveProperty("focus");
  });

  it.each(["/deep-html", "/deep-anubis"])(
    "refuses excessive nesting before extraction or challenge parsing: %s",
    async (path) => {
      const extractHtml = vi.fn();

      await expect(
        executeWebFetch({ url: `${origin}${path}` }, undefined, undefined, {
          ...dependencies,
          extractHtml,
        }),
      ).rejects.toThrow("safe extraction depth");
      expect(extractHtml).not.toHaveBeenCalled();
    },
  );

  it("keeps structured content bounded when acquisition is blocked", async () => {
    const result = await executeWebFetch(
      { url: `${origin}/captcha-challenge` },
      undefined,
      undefined,
      dependencies,
    );

    expect(Check(webFetchOutputSchema, result.structuredContent)).toBe(true);
    expect(result.structuredContent).toMatchObject({
      blocked: true,
      markdown: "",
      llmsTxtFallback: false,
    });
    expect(result.details.extractionDiagnostics?.botWall).toBe(true);
  });
});
