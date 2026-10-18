import { describe, expect, it } from "vite-plus/test";
import { diagnoseExtraction, extractDocumentLinks } from "../../src/evidence";

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
    expect(
      diagnoseExtraction(
        "<title>Anubis</title> Anubis is protecting this site with a proof-of-work challenge.",
        "Anubis challenge",
      ).botWall,
    ).toBe(true);
    expect(
      diagnoseExtraction(
        "<title>Anubis</title> The administrator of this website has set up Anubis to protect the server against scrapers. Anubis uses a Proof-of-Work scheme. This challenge protects the server.",
        "",
      ).botWall,
    ).toBe(true);
    expect(
      diagnoseExtraction(
        "Making sure you're not a bot! Loading...You are seeing this because the administrator of this website has set up Anubis to protect the server against the scourge of AI companies aggressively scraping websites. Anubis uses a Proof-of-Work scheme in the vein of Hashcash. Please note that Anubis requires the use of modern JavaScript features.",
        "",
      ).botWall,
    ).toBe(true);
    expect(
      diagnoseExtraction(
        "An article about Anubis proof-of-work challenges explains how the system works.",
        "Article",
      ).botWall,
    ).toBe(false);
    expect(
      diagnoseExtraction(
        "An administrator set up Anubis for a discussion about proof-of-work challenge systems.",
        "Article",
      ).botWall,
    ).toBe(false);
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
