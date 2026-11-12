import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vite-plus/test";
import { redditChallengeUrl } from "../src/challenges/reddit.ts";
import { fetchCompleteDocument } from "../src/acquisition/fetch.ts";

const url = new URL("https://www.reddit.com/r/example/comments/abc/post/?sort=new");

const html = `<html><head><script>document.addEventListener("DOMContentLoaded",async function(){var e=document.forms[0],n=(e.onsubmit=function(t){return new URLSearchParams(document.location.search).forEach((e,n)=>t.target.appendChild(Object.assign(document.createElement("input"),{name:n,type:"hidden",value:e}))),!0},await(async e=>e+e)("abc123"));e.elements.namedItem("solution").value=n,e.requestSubmit()},{once:!0});</script></head><body><form hidden method="GET" action="/r/example/comments/abc/post/"><input type="hidden" name="solution"/><input type="hidden" name="js_challenge" value="1"/><input type="hidden" name="jsc_token" value="123abc"/><input type="hidden" name="jsc_orig_r" value=""/></form></body></html>`;

describe("Reddit JavaScript challenge", () => {
  it("computes the observed literal operation without executing the script", () => {
    const pass = redditChallengeUrl(html, url);
    expect(pass?.searchParams.get("solution")).toBe("abc123abc123");
    expect(pass?.searchParams.get("sort")).toBe("new");
    expect(pass?.searchParams.get("jsc_token")).toBe("123abc");
  });

  it("refuses unexpected operations, form targets, fields and origins", () => {
    for (const raw of [
      html.replace("e=>e+e", "e=>e+e+e"),
      html.replace('action="/r/', 'action="https://evil.test/r/'),
      html.replace('name="jsc_orig_r"', 'name="solution"'),
      html.replace('value="123abc"', 'value="bad&token"'),
      html.replace('method="GET"', 'method="POST"'),
    ])
      expect(redditChallengeUrl(raw, url)).toBeUndefined();
    expect(
      redditChallengeUrl(html, new URL("https://evil.test/r/example/comments/abc/post/")),
    ).toBeUndefined();
    expect(redditChallengeUrl(html, new URL(`${url}&solution=evil`))).toBeUndefined();
  });

  it("preserves cancellation during a challenge pass", async () => {
    const controller = new AbortController();
    let calls = 0;
    await expect(
      fetchCompleteDocument(url.href, controller.signal, {
        validateUrl: async (value) => ({
          url: new URL(value),
          address: "93.184.216.34",
          family: 4,
        }),
        request: async () => {
          calls += 1;

          if (calls > 1) {
            controller.abort();
            throw new Error("aborted");
          }

          // SAFETY: this readable supplies the response fields used by the transport.
          const response = Readable.from([Buffer.from(html)]) as IncomingMessage;
          response.statusCode = 200;
          response.headers = { "content-type": "text/html" };

          return response;
        },
      }),
    ).rejects.toThrow("cancelled");
    expect(calls).toBe(2);
  });

  it("reuses cookies and hides handshake parameters from the result", async () => {
    const calls: string[] = [];
    let cookie = "";

    const doc = await fetchCompleteDocument(url.href, undefined, {
      validateUrl: async (value) => ({ url: new URL(value), address: "93.184.216.34", family: 4 }),
      request: async (target, _signal, headers) => {
        calls.push(target.url.href);
        cookie = headers?.Cookie ?? "";
        const first = calls.length === 1;

        // SAFETY: this readable supplies the response fields used by the transport.
        const response = Readable.from([
          Buffer.from(first ? html : "<html><body><p>Post content</p></body></html>"),
        ]) as IncomingMessage;

        response.statusCode = 200;
        response.headers = { "content-type": "text/html" };

        if (first) response.headers["set-cookie"] = ["session=abc; Path=/; Secure"];

        return response;
      },
    });

    expect(calls).toHaveLength(2);
    expect(cookie).toContain("session=abc");
    expect(doc.url).toBe(url.href);
    expect(doc.markdown).toContain("Post content");
    expect(doc.url).not.toContain("jsc_token");
  });
});
