import { describe, expect, it } from "vite-plus/test";
import { diagnoseExtraction, extractDocumentLinks } from "../src/evidence";

describe("bounded extraction diagnostics", () => {
  it("distinguishes JavaScript requirements, bot walls, consent, and sparse extraction", () => {
    expect(diagnoseExtraction("Please enable JavaScript", "")).toMatchObject({
      javascriptRequired: true,
      botWall: false,
      consentInterstitial: false,
      sparseExtraction: false,
    });
    expect(diagnoseExtraction("Checking your browser to verify you are human", "")).toMatchObject({
      javascriptRequired: false,
      botWall: true,
    });
    expect(diagnoseExtraction("We use cookies. Accept all cookies.", "")).toMatchObject({
      consentInterstitial: true,
    });
    expect(diagnoseExtraction("x".repeat(20_000), "tiny")).toMatchObject({
      sparseExtraction: true,
      rawCharacters: 20_000,
      extractedCharacters: 4,
    });
  });
});

describe("bounded extracted links", () => {
  it("normalizes internal and external links and rejects unsafe schemes and credentials", () => {
    const html = [
      '<a href="/guide#intro">  Internal guide </a>',
      '<a href="https://other.example/path#section">External</a>',
      '<a href="javascript:alert(1)">Unsafe</a>',
      '<a href="data:text/plain,no">Data</a>',
      '<a href="https://user:secret@other.example/private">Credentials</a>',
    ].join("");
    expect(extractDocumentLinks(html, new URL("https://example.com/docs/page"))).toEqual({
      internal: [{ url: "https://example.com/guide", anchorText: "Internal guide" }],
      external: [{ url: "https://other.example/path", anchorText: "External" }],
      omittedInternal: 0,
      omittedExternal: 0,
    });
  });

  it("caps each link category and reports omitted counts", () => {
    const html = Array.from(
      { length: 20 },
      (_, index) => `<a href="/page-${index}">Page ${index}</a>`,
    ).join("");
    const links = extractDocumentLinks(html, new URL("https://example.com/"));
    expect(links.internal).toHaveLength(16);
    expect(links.omittedInternal).toBe(4);
  });
});
