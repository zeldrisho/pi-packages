import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { fetchRemoteContent, requestPinned, type FetchRemoteDependencies } from "../src/index";
import { createFetchHarness } from "./harness";

describe("web_fetch transport", () => {
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

  it("pins transport requests to the validated address", async () => {
    const response = await requestPinned(
      {
        url: new URL(`${origin}/html`),
        address: "127.0.0.1",
        family: 4,
      },
      new AbortController().signal,
    );
    expect(response.statusCode).toBe(200);
    response.resume();
  });

  it("extracts HTML while removing executable content", async () => {
    const result = await fetchRemoteContent(`${origin}/html`, 0, 6_000, undefined, dependencies);
    expect(result.markdown).toContain("Hello");
    expect(result.markdown).toContain("World");
    expect(result.markdown).not.toContain("bad()");
    expect(result.title).toBe("Fixture");
  });

  it("accepts documentation-sized responses while keeping returned content bounded", async () => {
    const result = await fetchRemoteContent(
      `${origin}/documentation-sized`,
      0,
      6_000,
      undefined,
      dependencies,
    );
    expect(result.nextOffset).toBe(6_000);
    expect(result.markdown).toContain("[Content truncated.");
    expect(result.totalCharacters).toBe(1_500_000);
  });

  it.each([
    ["/binary", "does not support application/octet-stream"],
    ["/status", "HTTP 418"],
  ])("rejects invalid response from %s", async (path, message) => {
    await expect(
      fetchRemoteContent(`${origin}${path}`, 0, 6_000, undefined, dependencies),
    ).rejects.toThrow(message);
  });

  it("explains that a missing page may be private or require authentication", async () => {
    await expect(
      fetchRemoteContent(`${origin}/missing`, 0, 6_000, undefined, dependencies),
    ).rejects.toThrow(/HTTP 404.*page may be missing, private, or require authentication/);
  });

  it.each(["/declared-large", "/streamed-large"])(
    "reports the raw response limit and explains maxCharacters for %s",
    async (path) => {
      await expect(
        fetchRemoteContent(`${origin}${path}`, 0, 6_000, undefined, dependencies),
      ).rejects.toThrow(/raw download limit.*maxCharacters only controls returned output/);
    },
  );

  it("escapes untrusted-content closing tags", async () => {
    const result = await fetchRemoteContent(
      `${origin}/untrusted`,
      0,
      6_000,
      undefined,
      dependencies,
    );
    expect(result.markdown).toContain("&lt;/untrusted_web_content&gt;");
    expect(result.markdown).not.toContain("</untrusted_web_content>");
  });
});
