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
    } else {
      expect(document.extractionDiagnostics?.botWall).toBe(true);
    }
  });

  it("extracts a matching post and comments but not unrelated entries", () => {
    const feed = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>t3_1vi0wjy</id><title>Post title</title><content type="html">&lt;p&gt;Post body&lt;/p&gt;</content></entry><entry><id>t1_abc</id><content type="html">&lt;p&gt;A comment&lt;/p&gt;</content></entry></feed>`;
    const result = extractRedditFeed(feed, redditFeedUrl(url)!);
    expect(result).toContain("Post body");
    expect(result).toContain("A comment");
    expect(result).toContain("hierarchy is unavailable");
    expect(
      extractRedditFeed(feed.replace("t3_1vi0wjy", "t3_other"), redditFeedUrl(url)!),
    ).toBeUndefined();
  });
});
