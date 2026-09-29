import { describe, expect, it } from "vite-plus/test";
import { executeWebFetch } from "../../src/index";

const enabled = process.env.PI_WEB_FETCH_E2E === "1";

const url = `https://base-ui.com/production-error?code=31&pi_web_fetch_e2e=${Date.now()}`;

describe("live web fetch e2e", () => {
  it.skipIf(!enabled)(
    "fetches the rendered Base UI production error page",
    async () => {
      const result = await executeWebFetch({ url, maxCharacters: 12_000 }, undefined, undefined);
      const content = result.content.map((item) => item.text).join("\n");

      expect(result.details.llmsTxtFallback).toBe(false);
      expect(new URL(result.details.finalUrl).pathname).toBe("/production-error");
      expect(content).toContain("Production error #31");
      expect(content).toContain("MenuGroupContext is missing");
      expect(content).toContain("<Menu.Group>");
    },
    45_000,
  );
});
