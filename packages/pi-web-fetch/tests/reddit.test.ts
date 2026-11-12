import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vite-plus/test";
import { fetchCompleteDocument } from "../src/acquisition/fetch.ts";
import { redditFeedUrl, extractRedditFeed } from "../src/acquisition/reddit.ts";
import { diagnoseExtraction } from "../src/document/evidence.ts";

const url = "https://www.reddit.com/r/PiCodingAgent/comments/1vi0wjy/example/";

const challenge = `<html><body><form hidden><input name="solution"><input name="js_challenge" value="1"><input name="jsc_token" value="token"></form></body></html>`;

describe("Reddit fallback", () => {
  it("recognizes an empty challenge without flagging content-rich pages", () => {
    expect(diagnoseExtraction(challenge, "").botWall).toBe(true);
    expect(diagnoseExtraction(challenge, "content ".repeat(100)).botWall).toBe(false);
    expect(diagnoseExtraction('<input name="js_challenge">', "").botWall).toBe(false);
  });

  it("restricts feed URLs to Reddit post permalinks", () => {
    expect(redditFeedUrl(url)).toBe("https://www.reddit.com/r/PiCodingAgent/comments/1vi0wjy/.rss");
    expect(redditFeedUrl("https://reddit.com.evil.test/r/a/comments/123/x/")).toBeUndefined();
    expect(redditFeedUrl("https://reddit.com/r/a/")).toBeUndefined();
    expect(redditFeedUrl(`${url}comment123/`)).toBeUndefined();
  });

  it.each([200, 403, 429])("uses the feed only when it succeeds (HTTP %i)", async (status) => {
    const paths: string[] = [];

    const document = await fetchCompleteDocument(url, undefined, {
      validateUrl: async (value) => ({ url: new URL(value), address: "93.184.216.34", family: 4 }),
      sleep: async () => {},
      request: async (target) => {
        paths.push(target.url.pathname);
        const feed = target.url.pathname.endsWith("/.rss");

        const body = feed
          ? "<feed><entry><id>t3_1vi0wjy</id><title>Found post</title></entry></feed>"
          : challenge;

        // SAFETY: the fixture supplies the stream and response fields consumed by the transport.
        const response = Readable.from([Buffer.from(body)]) as IncomingMessage;
        response.statusCode = feed ? status : 200;
        response.headers = { "content-type": feed ? "application/atom+xml" : "text/html" };

        return response;
      },
    });

    expect(paths.some((path) => path.endsWith("/.rss"))).toBe(true);

    if (status === 200) {
      expect(document.markdown).toContain("Found post");
      expect(document.extractionDiagnostics?.botWall).not.toBe(true);
      expect(document.contentType).toBe("application/atom+xml");
      expect(document.title).toBeUndefined();
      expect(document.fragmentOffsets).toBeUndefined();
    } else {
      expect(document.extractionDiagnostics?.botWall).toBe(true);
    }
  });

  it.each([true, false])(
    "handles 403 bot walls without hiding ordinary errors (wall=%s)",
    async (wall) => {
      const paths: string[] = [];

      const fetch = fetchCompleteDocument(url, undefined, {
        validateUrl: async (value) => ({
          url: new URL(value),
          address: "93.184.216.34",
          family: 4,
        }),
        request: async (target) => {
          paths.push(target.url.pathname);
          const feed = target.url.pathname.endsWith("/.rss");

          const body = feed
            ? "<feed><entry><id>t3_1vi0wjy</id><title>Found post</title></entry></feed>"
            : wall
              ? challenge
              : "<html><body>Access denied</body></html>";

          // SAFETY: the fixture supplies the response stream and fields used by the transport.
          const response = Readable.from([Buffer.from(body)]) as IncomingMessage;
          response.statusCode = feed ? 200 : 403;
          response.headers = { "content-type": feed ? "application/atom+xml" : "text/html" };

          return response;
        },
      });

      if (wall) expect((await fetch).markdown).toContain("Found post");
      else await expect(fetch).rejects.toThrow("HTTP 403");
      expect(paths.some((path) => path.endsWith("/.rss"))).toBe(wall);
    },
  );

  it.each([true, false])(
    "permits only redirects to the same Reddit post (same=%s)",
    async (same) => {
      const paths: string[] = [];
      const initial = url.replace("www.reddit.com", "reddit.com");

      const result = await fetchCompleteDocument(initial, undefined, {
        validateUrl: async (value) => ({
          url: new URL(value),
          address: "93.184.216.34",
          family: 4,
        }),
        request: async (target) => {
          paths.push(target.url.href);
          const redirect = target.url.hostname === "reddit.com";
          const feed = target.url.pathname.endsWith("/.rss");

          const body = feed
            ? "<feed><entry><id>t3_1vi0wjy</id><title>Found post</title></entry></feed>"
            : challenge;

          // SAFETY: the fixture supplies the response stream and fields used by the transport.
          const response = Readable.from([Buffer.from(body)]) as IncomingMessage;
          response.statusCode = redirect ? 302 : 200;
          response.headers = redirect
            ? { location: same ? url : url.replace("1vi0wjy", "different") }
            : { "content-type": feed ? "application/atom+xml" : "text/html" };

          return response;
        },
      });

      expect(paths.some((path) => path.endsWith("/.rss"))).toBe(same);
      expect(result.markdown.includes("Found post")).toBe(same);
    },
  );

  it("extracts a matching post and comments but not unrelated entries", () => {
    const feed = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>t3_1vi0wjy</id><title>Post title</title><content type="html">&lt;p&gt;Post body&lt;/p&gt;</content></entry><entry><id>t1_abc</id><content type="html">&lt;p&gt;A comment&lt;/p&gt;</content></entry></feed>`;
    const result = extractRedditFeed(feed, redditFeedUrl(url)!);
    expect(result).toContain("Post body");
    expect(
      extractRedditFeed(
        feed.replace("Post body&lt;/p&gt;", "Not&lt;/p&gt;&lt;p&gt;allowed&lt;/p&gt;"),
        redditFeedUrl(url)!,
      ),
    ).toContain("Not\n\nallowed");
    expect(result).toContain("A comment");
    expect(result).toContain("hierarchy is unavailable");
    expect(
      extractRedditFeed(feed.replace("t3_1vi0wjy", "t3_other"), redditFeedUrl(url)!),
    ).toBeUndefined();
  });
});
