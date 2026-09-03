import { describe, expect, it } from "vite-plus/test";
import { redactUrlForDisplay } from "../src/redact";

describe("redactUrlForDisplay", () => {
  it("removes URL user information", () => {
    const output = redactUrlForDisplay("https://user:password@example.com/private");

    expect(output).toBe("https://example.com/private");
    expect(output).not.toContain("user");
    expect(output).not.toContain("password");
  });

  it("redacts common credential-bearing query parameters case-insensitively", () => {
    const output = redactUrlForDisplay(
      "https://example.com/page?token=secret-token&API_KEY=secret-key&client_secret=oauth-secret&refresh_token=refresh-secret&page=2",
    );

    expect(output).toBe(
      "https://example.com/page?token=REDACTED&API_KEY=REDACTED&client_secret=REDACTED&refresh_token=REDACTED&page=2",
    );
    expect(output).not.toContain("secret-token");
    expect(output).not.toContain("secret-key");
    expect(output).not.toContain("oauth-secret");
    expect(output).not.toContain("refresh-secret");
  });

  it("redacts credential-bearing fragment parameters case-insensitively", () => {
    const output = redactUrlForDisplay(
      "https://example.com/callback#access_token=secret-token&CLIENT_SECRET=oauth-secret&state=ok",
    );

    expect(output).toBe(
      "https://example.com/callback#access_token=REDACTED&CLIENT_SECRET=REDACTED&state=ok",
    );
    expect(output).not.toContain("secret-token");
    expect(output).not.toContain("oauth-secret");
  });

  it("preserves ordinary query parameters and fragments", () => {
    expect(redactUrlForDisplay("https://example.com/search?q=pi&lang=en#section-1")).toBe(
      "https://example.com/search?q=pi&lang=en#section-1",
    );
  });

  it("does not echo malformed input that may contain a secret", () => {
    const output = redactUrlForDisplay("not a URL?token=secret-token");

    expect(output).toBe("[invalid URL]");
    expect(output).not.toContain("secret-token");
  });
});
