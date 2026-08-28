import { describe, expect, it } from "vite-plus/test";
import {
  createDocumentOutline,
  MAX_OUTLINE_HEADING_CHARACTERS,
  MAX_OUTLINE_HEADINGS,
} from "../src/outline";

describe("document outlines", () => {
  it("reports ATX headings, levels, and section word counts", () => {
    const outline = createDocumentOutline(
      [
        "Preamble words.",
        "# Guide",
        "Introductory text here.",
        "## Setup ##",
        "Install the package now.",
        "## Usage",
        "Run the command.",
      ].join("\n"),
    );

    expect(outline).toEqual({
      totalWords: 15,
      totalHeadings: 3,
      headings: [
        { level: 1, text: "Guide", words: 3, inferred: false },
        { level: 2, text: "Setup", words: 4, inferred: false },
        { level: 2, text: "Usage", words: 3, inferred: false },
      ],
      omittedHeadings: 0,
    });
  });

  it("ignores heading syntax inside backtick and tilde fences", () => {
    const outline = createDocumentOutline(
      [
        "# Real",
        "```md",
        "## Not a section",
        "```",
        "~~~",
        "### Also not a section",
        "~~~",
        "Body text.",
      ].join("\n"),
    );

    expect(outline.totalHeadings).toBe(1);
    expect(outline.headings[0]).toMatchObject({ text: "Real", inferred: false });
  });

  it("conservatively infers short title lines only when ATX headings are absent", () => {
    const outline = createDocumentOutline(
      [
        "Installation",
        "Install this package with the package manager and then configure it for your project.",
        "Usage",
        "Run the command from your project directory after installation.",
      ].join("\n"),
    );

    expect(outline.headings).toEqual([
      { level: 2, text: "Installation", words: 14, inferred: true },
      { level: 2, text: "Usage", words: 9, inferred: true },
    ]);
  });

  it("does not infer headings from ordinary prose or lists", () => {
    const outline = createDocumentOutline(
      [
        "This is a normal sentence.",
        "Another ordinary paragraph follows here.",
        "- A list item",
        "- Another list item",
      ].join("\n"),
    );

    expect(outline.totalHeadings).toBe(0);
    expect(outline.headings).toEqual([]);
  });

  it("bounds heading count and remote heading text", () => {
    const longHeading = "A".repeat(MAX_OUTLINE_HEADING_CHARACTERS + 20);
    const markdown = [
      `# ${longHeading}`,
      ...Array.from({ length: MAX_OUTLINE_HEADINGS + 2 }, (_, index) =>
        [`## Section ${index}`, "Body."].join("\n"),
      ),
    ].join("\n");
    const outline = createDocumentOutline(markdown);

    expect(outline.totalHeadings).toBe(MAX_OUTLINE_HEADINGS + 3);
    expect(outline.headings).toHaveLength(MAX_OUTLINE_HEADINGS);
    expect(outline.headings[0].text).toHaveLength(MAX_OUTLINE_HEADING_CHARACTERS);
    expect(outline.omittedHeadings).toBe(3);
  });
});
