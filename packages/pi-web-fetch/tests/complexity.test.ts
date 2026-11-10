import { describe, expect, it } from "vite-plus/test";
import { parseHTML } from "linkedom";
import { exceedsConversionDepth, MAX_CONVERSION_DEPTH } from "../src/document/complexity.ts";

/** Returns the deepest element depth linkedom actually builds for a fragment. */
function linkedomDepth(html: string): number {
  let max = 0;

  const walk = (node: Element, depth: number): void => {
    max = Math.max(max, depth);

    for (const child of node.children) walk(child, depth + 1);
  };

  for (const child of parseHTML(html).document.children) walk(child, 0);

  return max;
}

describe("conversion depth preflight", () => {
  it("refuses genuinely deep nesting", () => {
    const html = `${"<div>".repeat(MAX_CONVERSION_DEPTH + 1)}x${"</div>".repeat(MAX_CONVERSION_DEPTH + 1)}`;
    expect(exceedsConversionDepth(html)).toBe(true);
    expect(linkedomDepth(html)).toBeGreaterThanOrEqual(MAX_CONVERSION_DEPTH);
  });

  it("accepts a document at the limit", () => {
    const html = `${"<div>".repeat(MAX_CONVERSION_DEPTH)}x`;
    expect(exceedsConversionDepth(html)).toBe(false);
  });

  it("applies the optional end tags that linkedom applies", () => {
    const cases = [
      // Generated documentation pages omit most `p` end tags.
      `${"<p>prose".repeat(400)}`,
      `<ul>${"<li>item".repeat(400)}</ul>`,
      `<table>${"<tr><td>cell".repeat(400)}</table>`,
      `<dl>${"<dt>term<dd>definition".repeat(400)}</dl>`,
      `<select>${"<option>choice".repeat(400)}</select>`,
      `<ruby>base${"<rt>note".repeat(400)}</ruby>`,
    ];

    for (const html of cases) {
      expect(exceedsConversionDepth(html)).toBe(false);
      expect(linkedomDepth(html)).toBeLessThan(MAX_CONVERSION_DEPTH);
    }
  });

  it("still refuses a deep chain of unclosed block elements", () => {
    // `<div>` is not closed by `<p>`, so this really does nest in linkedom.
    const html = `${`<div><p>prose`.repeat(MAX_CONVERSION_DEPTH + 1)}`;
    expect(linkedomDepth(html)).toBeGreaterThan(MAX_CONVERSION_DEPTH);
    expect(exceedsConversionDepth(html)).toBe(true);
  });

  it("keeps an implied tag open when an intervening element blocks the close", () => {
    // linkedom closes an implied end tag only while it is on top of its stack, so these
    // nest even though a `li`, `td`, or `p` appears open earlier.
    const cases = [
      `<ul>${"<li><div>x".repeat(400)}</ul>`,
      `${"<p>a<span>b<p>c".repeat(400)}`,
      `<table>${"<tr><td><div>x".repeat(400)}`,
      `<ul>${"<li><p>item".repeat(400)}`,
    ];

    for (const html of cases) {
      expect(linkedomDepth(html)).toBeGreaterThan(MAX_CONVERSION_DEPTH);
      expect(exceedsConversionDepth(html)).toBe(true);
    }
  });

  it("still refuses unclosed elements that linkedom nests", () => {
    const html = `${"<section><span>text".repeat(400)}`;
    expect(linkedomDepth(html)).toBeGreaterThan(MAX_CONVERSION_DEPTH);
    expect(exceedsConversionDepth(html)).toBe(true);
  });

  it("honors self-closing foreign content but not HTML elements", () => {
    const svg = `<svg>${"<path/>".repeat(MAX_CONVERSION_DEPTH * 2)}</svg>`;
    expect(linkedomDepth(svg)).toBeLessThan(MAX_CONVERSION_DEPTH);
    expect(exceedsConversionDepth(svg)).toBe(false);

    const html = `${"<span/>".repeat(MAX_CONVERSION_DEPTH + 1)}`;
    expect(exceedsConversionDepth(html)).toBe(true);
  });

  it("does not let raw text or comments hide nesting", () => {
    expect(exceedsConversionDepth(`<script>${"<div>".repeat(10)}</script>`)).toBe(false);
    expect(exceedsConversionDepth(`<script>${"<div>".repeat(10)}`)).toBe(false);
    expect(exceedsConversionDepth(`<!-- ${"<div>".repeat(10)} -->`)).toBe(false);
    expect(exceedsConversionDepth(`<div title="<div>">`)).toBe(false);
  });
});
