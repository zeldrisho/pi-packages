import { DOMParser } from "linkedom";
import { assertConversionDepth } from "../document/complexity.ts";
import { htmlToMarkdownFallback } from "../document/extract.ts";

/** Restrict the fallback to public Reddit post permalinks, never arbitrary hosts. */
export function redditFeedUrl(rawUrl: string): string | undefined {
  const url = new URL(rawUrl);

  if (
    url.protocol !== "https:" ||
    !["reddit.com", "www.reddit.com", "old.reddit.com"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.port
  )
    return undefined;

  const match = /^\/r\/([a-z0-9_]+)\/comments\/([a-z0-9]+)(?:\/[^/]*)?(?:\/[^/]*)?\/?$/i.exec(
    url.pathname,
  );

  if (!match) return undefined;

  return `https://www.reddit.com/r/${match[1]}/comments/${match[2]}/.rss`;
}

/** Render the anonymous Atom representation; it does not preserve comment hierarchy. */
export function extractRedditFeed(raw: string, feedUrl: string): string | undefined {
  assertConversionDepth(raw);
  const document = new DOMParser().parseFromString(raw, "text/xml");

  if (document.documentElement?.localName !== "feed") return undefined;
  const id = /\/comments\/([a-z0-9]+)\//i.exec(new URL(feedUrl).pathname)?.[1];
  const entries = [...document.querySelectorAll("entry")];

  const post = entries.find(
    (entry) => entry.querySelector("id")?.textContent?.trim() === `t3_${id}`,
  );

  if (!post) return undefined;

  const render = (entry: Element): string => {
    const author = entry.querySelector("author name")?.textContent?.trim();
    const title = entry.querySelector("title")?.textContent?.trim();
    const content = entry.querySelector("content")?.textContent ?? "";
    const text = htmlToMarkdownFallback(content);

    return [title, author ? `By ${author}` : "", text].filter(Boolean).join("\n\n");
  };

  const main = render(post);

  if (!main) return undefined;

  const comments: string[] = [];

  for (const entry of entries) {
    if (
      entry === post ||
      !/^t1_[a-z0-9]+$/i.test(entry.querySelector("id")?.textContent?.trim() ?? "")
    )
      continue;
    const comment = render(entry);

    if (comment) comments.push(comment);
  }

  return [
    "Reddit Atom feed; comments may be incomplete and thread hierarchy is unavailable.",
    main,
    ...comments.map((comment) => `## Comment\n\n${comment}`),
  ].join("\n\n");
}
