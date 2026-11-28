import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vite-plus/test";
import { sliceCompleteDocument } from "../src/document/content.ts";

const document = (markdown: string) => ({
  url: "https://example.test/",
  contentType: "text/markdown",
  markdown,
  extractor: "raw" as const,
  shellSuspected: false,
});

it("returns a whole-character prefix and a progressing offset at each content limit", () => {
  const byteBudget = Math.max(1024, DEFAULT_MAX_BYTES - 2048);
  const lineBudget = DEFAULT_MAX_LINES - 10;
  // Leave three bytes after the last complete emoji. Its high surrogate alone
  // could fit as a replacement character, but must not be returned on its own.
  const prefix = "x".repeat((byteBudget - 3) % 4);
  const fittingEmojiCount = Math.floor((byteBudget - prefix.length) / 4);
  const emoji = "🙂";

  const samples = [
    ["characters", `head\né界${emoji}tail`, 5, 4, `é界${emoji}`],
    [
      "lines",
      "line\n".repeat(DEFAULT_MAX_LINES),
      0,
      10 * DEFAULT_MAX_LINES,
      Array<string>(lineBudget - 1)
        .fill("line")
        .join("\n"),
    ],
    [
      "bytes",
      prefix + emoji.repeat(fittingEmojiCount + 1),
      0,
      byteBudget,
      prefix + emoji.repeat(fittingEmojiCount),
    ],
  ] as const;

  for (const [label, markdown, offset, limit, expected] of samples) {
    const nextOffset = offset + expected.length;
    const result = sliceCompleteDocument(document(markdown), offset, limit);

    expect.soft(result, label).toMatchObject({
      offset,
      nextOffset,
      totalCharacters: markdown.length,
      truncated: true,
      markdown: `${expected}\n\n[Content truncated. Continue with offset=${nextOffset} to read the next chunk.]`,
    });
  }
});
