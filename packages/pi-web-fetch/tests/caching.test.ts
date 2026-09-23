import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { executeWebFetch, fetchRemoteContent, type FetchRemoteDependencies } from "../src/index";
import { createFetchHarness } from "./harness";

describe("web_fetch caching", () => {
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

  it("starts GitHub-style source fetches at line fragments", async () => {
    const result = await executeWebFetch(
      { url: `${origin}/line-fragments.rs#L3` },
      undefined,
      undefined,
      dependencies,
    );

    expect(result.content[0].text).toContain("[Starting at the requested URL fragment.]");
    expect(result.content[0].text).toContain("let second = 2;");
    expect(result.content[0].text).not.toContain("let first = 1;");
    expect(result.details.fragment).toMatchObject({ requested: "L3", matched: true });
  });

  it("limits GitHub source line ranges and column selections", async () => {
    const range = await executeWebFetch(
      { url: `${origin}/line-fragments.rs#L2-L3` },
      undefined,
      undefined,
      dependencies,
    );

    expect(range.content[0].text).toContain("let first = 1;");
    expect(range.content[0].text).toContain("let second = 2;");
    expect(range.content[0].text).not.toContain("fn main()");
    expect(range.content[0].text).not.toContain("[Content truncated.");

    const columns = await executeWebFetch(
      { url: `${origin}/line-fragments.rs#L2C3-L2C12` },
      undefined,
      undefined,
      dependencies,
    );

    expect(columns.content[0].text).toContain("let first");
    expect(columns.content[0].text).not.toContain("let second");
  });

  it("starts GitHub-style Markdown fetches at a heading fragment", async () => {
    const result = await executeWebFetch(
      { url: `${origin}/markdown-fragments.md#styling` },
      undefined,
      undefined,
      dependencies,
    );

    expect(result.content[0].text).toContain("[Starting at the requested URL fragment.]");
    expect(result.content[0].text).toContain("### Styling\nStyle guidance.");
    expect(result.content[0].text).not.toContain("# Guide");
    expect(result.content[0].text).not.toContain("Not a heading");
    expect(result.details.fragment).toMatchObject({ requested: "styling", matched: true });
  });

  it("resolves Markdown link and Setext heading slugs", async () => {
    const linked = await executeWebFetch(
      { url: `${origin}/markdown-fragments.md#linked-style-guide` },
      undefined,
      undefined,
      dependencies,
    );

    const setext = await executeWebFetch(
      { url: `${origin}/markdown-fragments.md#setext-section` },
      undefined,
      undefined,
      dependencies,
    );

    expect(linked.content[0].text).toContain("Linked [Style](https://example.test) Guide");
    expect(linked.content[0].text).not.toContain("# Guide");
    expect(setext.content[0].text).toContain("Setext Section\n===");
    expect(setext.content[0].text).not.toContain("Linked [Style]");
  });

  it("strips complete and malformed HTML tags from Markdown fragment slugs", async () => {
    for (const slug of ["safe", "nestedipt", "script"]) {
      const result = await executeWebFetch(
        { url: `${origin}/markdown-fragments.md#${slug}` },
        undefined,
        undefined,
        dependencies,
      );

      expect(result.details.fragment).toMatchObject({ requested: slug, matched: true });
    }
  });

  it("returns stable continuation offsets", async () => {
    const first = await fetchRemoteContent(
      `${origin}/continuation`,
      0,
      1_000,
      undefined,
      dependencies,
    );

    expect(first.truncated).toBe(true);
    expect(first.nextOffset).toBe(1_000);

    const second = await fetchRemoteContent(
      `${origin}/continuation`,
      first.nextOffset!,
      2_000,
      undefined,
      dependencies,
    );

    expect(second.offset).toBe(1_000);
    expect(second.markdown).toContain("[End of page content.]");
  });

  it("reuses one extracted page across continuation chunks", async () => {
    fixture.resetContinuationRequests();
    const url = `${origin}/versioned-continuation?cache=continuation`;
    const updates: string[] = [];

    const first = await executeWebFetch(
      { url, maxCharacters: 1_000 },
      undefined,
      (update) => updates.push(update.content[0].text),
      dependencies,
    );

    expect(first.details.cached).toBe(false);
    expect(first.details.nextOffset).toBe(1_000);
    expect(first.details.truncation).toEqual({
      truncated: true,
      strategy: "continuation",
      nextOffset: 1_000,
    });
    expect(fixture.continuationRequests()).toBe(1);

    const continuation = { url, offset: first.details.nextOffset, maxCharacters: 2_000 };

    const second = await executeWebFetch(
      continuation,
      undefined,
      (update) => updates.push(update.content[0].text),
      dependencies,
    );

    const repeated = await executeWebFetch(continuation, undefined, undefined, dependencies);

    expect(second.details.cached).toBe(true);
    expect(repeated.details.cached).toBe(true);
    expect(fixture.continuationRequests()).toBe(1);
    expect(second.content[0].text).toContain("end-version-1");
    expect(second.content[0].text).not.toContain("version-2");
    expect(updates).toEqual([`Fetching ${url}…`, `Using cached content for ${url}…`]);
  });

  it("derives focused views from the complete cached document", async () => {
    const url = `${origin}/focused?request=${Date.now()}`;

    const focused = await executeWebFetch(
      { url, query: "caching" },
      undefined,
      undefined,
      dependencies,
    );

    const complete = await executeWebFetch({ url }, undefined, undefined, dependencies);

    expect(focused.content[0].text).toContain("Caching stores complete pages.");
    expect(focused.content[0].text).not.toContain("Installation uses Vite+.");
    expect(focused.details.focus).toMatchObject({
      query: "caching",
      matchedSections: 1,
      totalSections: 3,
      omittedSections: 2,
    });
    expect(focused.details.totalCharacters).toBe("Caching stores complete pages.".length);
    expect(complete.details.cached).toBe(true);
    expect(complete.details.focus).toBeUndefined();
    expect(complete.content[0].text).toContain("Installation uses Vite+.");
  });

  it("reports an empty focused view without claiming the page had no readable text", async () => {
    const result = await executeWebFetch(
      { url: `${origin}/focused?none=${Date.now()}`, query: "quasar" },
      undefined,
      undefined,
      dependencies,
    );

    expect(result.content[0].text).toContain("No source sections matched the focus query");
    expect(result.content[0].text).not.toContain("page contained no readable text");
    expect(result.details.focus?.matchedSections).toBe(0);
  });

  it("rejects invalid focus queries at the runtime boundary", async () => {
    await expect(
      executeWebFetch(
        { url: `${origin}/focused`, query: "   " },
        undefined,
        undefined,
        dependencies,
      ),
    ).rejects.toThrow("query must contain between 1 and 400 characters");
  });

  it("coalesces concurrent fetches without letting one caller cancel another", async () => {
    fixture.resetCoalescedRequests();
    const url = `${origin}/coalesced?request=${Date.now()}`;
    const controller = new AbortController();
    const cancelled = executeWebFetch({ url }, controller.signal, undefined, dependencies);
    const completed = executeWebFetch({ url }, undefined, undefined, dependencies);
    await vi.waitFor(() => expect(fixture.coalescedRequests()).toBe(1));
    const cancelledExpectation = expect(cancelled).rejects.toThrow("cancelled");
    controller.abort();

    await cancelledExpectation;
    await expect(completed).resolves.toMatchObject({ details: { cached: false } });
    expect(fixture.coalescedRequests()).toBe(1);
  });

  it("wraps tool output and caches identical requests", async () => {
    const updates: string[] = [];
    const params = { url: `${origin}/html`, maxCharacters: 6_000 };

    const first = await executeWebFetch(
      params,
      undefined,
      (update) => updates.push(update.content[0].text),
      dependencies,
    );

    const second = await executeWebFetch(
      params,
      undefined,
      (update) => updates.push(update.content[0].text),
      dependencies,
    );

    expect(first.details.cached).toBe(false);
    expect(second.details.cached).toBe(true);
    expect(first.content[0].text).toContain("<untrusted_web_content");
    expect(first.content[0].text).toContain("</untrusted_web_content>");
    expect(first.details.truncation).toEqual({
      truncated: false,
      strategy: "none",
      nextOffset: undefined,
    });
    expect(updates).toEqual([`Fetching ${params.url}…`, `Using cached content for ${params.url}…`]);
  });
});
