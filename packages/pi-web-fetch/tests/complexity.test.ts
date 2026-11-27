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

  it("applies self-closing syntax in foreign content, not in HTML", () => {
    const cases = [
      // foreignObject re-enters HTML mode, so its own slash is ignored and the following
      // HTML elements nest; a normal SVG path remains self-closing.
      { html: `<svg>${"<foreignObject/><div>".repeat(600)}`, exceeds: true },
      { html: `<svg>${"<foreignObject><div/>".repeat(600)}`, exceeds: true },
      { html: `<svg>${"<path/>".repeat(600)}`, exceeds: false },
    ];

    for (const { html, exceeds } of cases) {
      expect(linkedomDepth(html) > MAX_CONVERSION_DEPTH).toBe(exceeds);
      expect(exceedsConversionDepth(html)).toBe(exceeds);
    }

    expect(exceedsConversionDepth("<span/>".repeat(MAX_CONVERSION_DEPTH + 1))).toBe(true);
  });

  it("does not treat a slash in an unquoted attribute value as self-closing", () => {
    const html = `<svg>${"<g a=x/>".repeat(600)}`;

    expect(linkedomDepth(html)).toBeGreaterThan(MAX_CONVERSION_DEPTH);
    expect(exceedsConversionDepth(html)).toBe(true);
  });

  it("still refuses unclosed elements that linkedom nests", () => {
    const html = `${"<section><span>text".repeat(400)}`;
    expect(linkedomDepth(html)).toBeGreaterThan(MAX_CONVERSION_DEPTH);
    expect(exceedsConversionDepth(html)).toBe(true);
  });

  it("does not count void elements or markup-like text toward the nesting ceiling", () => {
    const tags = "<div>".repeat(MAX_CONVERSION_DEPTH + 1);
    const leaf = "<p>Visible</p>";

    const cases = {
      comment: `<!-- ${tags} -->${leaf}`,
      "void elements": `${"<br>".repeat(MAX_CONVERSION_DEPTH + 1)}<img src="x">${leaf}`,
      script: `<script>${tags}</script>${leaf}`,
      "unterminated script": `<script>${tags}`,
      "attribute value": `<div title="${tags}">${leaf}</div>`,
    };

    for (const [scenario, html] of Object.entries(cases)) {
      expect.soft(exceedsConversionDepth(html), scenario).toBe(false);
    }
  });
});
