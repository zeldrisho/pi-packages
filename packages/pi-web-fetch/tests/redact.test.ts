import { describe, expect, it } from "vite-plus/test";
import { redactUrlForDisplay } from "../src/redact";

describe("redactUrlForDisplay", () => {
  it("removes user info and redacts credentials in the query and fragment", () => {
    const secret = encodeURIComponent("sëcret:@&=");

    const output = redactUrlForDisplay(
      `https://user:${secret}@example.com/page?token=${secret}&API_KEY=secret-key&client_secret=oauth-secret&refresh_token=refresh-secret&page=2` +
        `#access_token=${secret}&CLIENT_SECRET=fragment-secret&state=ok`,
    );

    expect(output).toBe(
      "https://example.com/page?token=REDACTED&API_KEY=REDACTED&client_secret=REDACTED&refresh_token=REDACTED&page=2" +
        "#access_token=REDACTED&CLIENT_SECRET=REDACTED&state=ok",
    );
  });

  it("preserves ordinary query parameters and fragments", () => {
    expect(redactUrlForDisplay("https://example.com/search?q=pi&lang=en#section-1")).toBe(
      "https://example.com/search?q=pi&lang=en#section-1",
    );
  });

  it("does not echo malformed input that may contain a secret", () => {
    const output = redactUrlForDisplay("not a URL?token=secret-token");

    expect(output).toBe("[invalid URL]");
  });
});
