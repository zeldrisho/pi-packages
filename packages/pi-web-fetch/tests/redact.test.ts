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
      "https://example.com/page?token=secret-token&API_KEY=secret-key&page=2",
    );

    expect(output).toBe("https://example.com/page?token=REDACTED&API_KEY=REDACTED&page=2");
    expect(output).not.toContain("secret-token");
    expect(output).not.toContain("secret-key");
  });

  it("preserves ordinary query parameters", () => {
    expect(redactUrlForDisplay("https://example.com/search?q=pi&lang=en")).toBe(
      "https://example.com/search?q=pi&lang=en",
    );
  });

  it("does not echo malformed input that may contain a secret", () => {
    const output = redactUrlForDisplay("not a URL?token=secret-token");

    expect(output).toBe("[invalid URL]");
    expect(output).not.toContain("secret-token");
  });
});
