import { describe, expect, it } from "vite-plus/test";
import {
  createDocumentOutline,
  MAX_OUTLINE_HEADING_CHARACTERS,
  MAX_OUTLINE_HEADINGS,
} from "../src/document/outline.ts";

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

  it("parses whitespace and closing markers without backtracking", () => {
    const outline = createDocumentOutline(
      [
        "\t# Tab-indented",
        "Body.",
        "### Heading\t###\t",
        "More body.",
        `${"\t".repeat(100_000)}x`,
      ].join("\n"),
    );

    expect(outline.headings).toEqual([
      { level: 1, text: "Tab-indented", words: 1, inferred: false },
      { level: 3, text: "Heading", words: 3, inferred: false },
    ]);
  });

  it("ignores headings inside tilde and backtick fences until a valid close", () => {
    const outline = createDocumentOutline(
      [
        "# Real",
        "````md",
        "## Hidden one",
        "```",
        "## Hidden two",
        "```` not a close",
        "## Hidden three",
        "````",
        "## Visible",
        "~~~",
        "### Hidden in a tilde fence",
        "~~~",
        "Body.",
      ].join("\n"),
    );

    expect(outline.headings.map(({ text }) => text)).toEqual(["Real", "Visible"]);
  });

  it("conservatively infers short title lines only when ATX headings are absent", () => {
    const outline = createDocumentOutline(
      [
        "Installation",
        "Install this package with the package manager and then configure it for your project.",
        "Usage",
        "Run the command from your project directory after installation.",
        "- A list item",
        "- Another list item",
      ].join("\n"),
    );

    expect(outline.headings).toEqual([
      { level: 2, text: "Installation", words: 14, inferred: true },
      { level: 2, text: "Usage", words: 17, inferred: true },
    ]);
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
