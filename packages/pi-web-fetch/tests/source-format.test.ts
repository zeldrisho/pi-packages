import { describe, expect, it } from "vite-plus/test";
import {
  formatMinifiedSource,
  indentMinifiedSource,
  sourceLanguageFor,
} from "../src/document/source-format.ts";

/** Removes all whitespace so layout-only changes can be compared against the source. */
const withoutWhitespace = (value: string): string => value.replace(/\s+/gu, "");

/** A minified body long enough to clear the reformatting threshold. */
const minifiedOpenApi = (): string =>
  `import{a}from"./chunk.js";const e={openapi:"3.1.1",info:{title:"Wallet",description:"${"Endpoint documentation. ".repeat(100)}"},paths:{"/sapi/v1/capital/deposit/hisrec":{get:{summary:"Deposit \\"History\\"",tags:["capital"],values:[-1,2.5e3,true,false,null]}}}};export{e as default};`;

describe("indentMinifiedSource", () => {
  it("adds line breaks and indentation without altering any character", () => {
    const source = minifiedOpenApi();
    const indented = indentMinifiedSource(source);

    expect(indented).toBeDefined();
    expect(indented!.split("\n").length).toBeGreaterThan(10);
    expect(indented).toContain('  openapi:"3.1.1",');
    // Layout is the only change: no character was dropped, added, or reordered.
    expect(withoutWhitespace(indented!)).toBe(withoutWhitespace(source));
  });

  it("keeps punctuation inside string literals out of the layout", () => {
    const source = `const e={a:"x,y:{z}[1]",b:'open{brace',c:"esc\\"aped,still",d:1};${"pad".repeat(700)}`;

    expect(indentMinifiedSource(source)!.split("\n")).toEqual([
      "const e={",
      '  a:"x,y:{z}[1]",',
      "  b:'open{brace',",
      '  c:"esc\\"aped,still",',
      "  d:1",
      "};",
      "pad".repeat(700),
    ]);
  });

  it("leaves short and already-structured source alone", () => {
    expect(indentMinifiedSource("const e={a:1};")).toBeUndefined();

    const structured = Array.from(
      { length: 200 },
      (_, index) => `const v${index} = ${index};`,
    ).join("\n");

    expect(indentMinifiedSource(structured)).toBeUndefined();
  });

  it("leaves oversized bodies in their original layout", () => {
    expect(indentMinifiedSource("a,".repeat(1_100_000))).toBeUndefined();
  });

  it("bounds indentation for deeply nested input", () => {
    const nested = "{".repeat(200) + "1" + "}".repeat(200) + "p".repeat(2_100);
    const indented = indentMinifiedSource(nested);

    expect(indented).toBeDefined();

    const deepestIndent = Math.max(
      ...indented!.split("\n").map((line) => line.length - line.trimStart().length),
    );

    expect(deepestIndent).toBe(48);
  });
});

describe("formatMinifiedSource", () => {
  it("fences reformatted source with a language for its media type", () => {
    expect(sourceLanguageFor("text/javascript")).toBe("js");
    expect(sourceLanguageFor("text/yaml")).toBe("yaml");
    expect(sourceLanguageFor("text/html")).toBeUndefined();

    const formatted = formatMinifiedSource(minifiedOpenApi(), "text/javascript");

    expect(formatted?.language).toBe("js");
    expect(formatted?.markdown.startsWith("```js\n")).toBe(true);
    expect(formatted?.markdown.endsWith("\n```")).toBe(true);
  });

  it("does not reformat prose, HTML, or short bodies", () => {
    expect(formatMinifiedSource("plain prose", "text/plain")).toBeUndefined();
    expect(formatMinifiedSource(`<p>${"text ".repeat(600)}</p>`, "text/html")).toBeUndefined();
    expect(formatMinifiedSource(`{"a":1}`, "application/json")).toBeUndefined();
  });
});
