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
